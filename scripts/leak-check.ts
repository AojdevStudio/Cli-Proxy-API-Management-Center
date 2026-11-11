import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { ALLOWLIST } from './leak-allowlist';

export type RuleId =
  | 'email'
  | 'tailnet-host'
  | 'tailnet-ip'
  | 'gateway-key'
  | 'gateway-env'
  | 'private-key'
  | 'api-key'
  | 'bearer-token'
  | 'github-token';

interface Rule {
  id: RuleId;
  what: string;
  pattern: RegExp;
  /** Narrows a regex hit that the pattern alone cannot decide. */
  accept?: (match: RegExpExecArray) => boolean;
}

export interface AllowEntry {
  rule: RuleId;
  /** Exact file paths, or folder prefixes ending in "/". */
  paths: readonly string[];
  /** A pattern for the matched text, or SHA-256 digests so the list never holds the value. */
  match: RegExp | { sha256: readonly string[] };
  reason: string;
}

export interface Finding {
  file: string;
  line: number;
  rule: RuleId;
}

const octet = (value: string) => Number(value) <= 255;

/** `git@host:owner/repo` and `ssh://git@host/...` are SSH remotes, not mailboxes. */
const isSshRemote = ({ 0: value, index, input }: RegExpExecArray) =>
  value.startsWith('git@') &&
  (input[index + value.length] === ':' || input.slice(0, index).endsWith('ssh://'));

export const RULES: readonly Rule[] = [
  {
    id: 'email',
    what: 'email address',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    accept: (match) => !isSshRemote(match),
  },
  {
    id: 'tailnet-host',
    what: 'Tailscale MagicDNS name',
    pattern: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/gi,
  },
  {
    id: 'tailnet-ip',
    what: 'tailnet IP in the CGNAT range',
    pattern: /\b100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g,
    accept: ([, second, third, fourth]) =>
      Number(second) >= 64 && Number(second) <= 127 && octet(third) && octet(fourth),
  },
  {
    id: 'gateway-key',
    what: 'gateway client key',
    pattern: /\bcpa-[a-z0-9][a-z0-9_-]*-[0-9a-f]{48}(?![0-9a-f])/gi,
  },
  {
    id: 'gateway-env',
    what: 'CLIProxyAPI environment key name',
    pattern: /\bCLIPROXYAPI_[A-Za-z0-9_]+/g,
  },
  {
    id: 'private-key',
    what: 'private key header',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
  },
  {
    id: 'api-key',
    what: 'sk- style API key',
    pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'bearer-token',
    what: 'bearer token',
    pattern: /\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
  },
  {
    id: 'github-token',
    what: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,})\b/g,
  },
];

const RULE_WHAT = new Map(RULES.map((rule) => [rule.id, rule.what]));

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const coversPath = (entry: AllowEntry, file: string) =>
  entry.paths.some((path) => (path.endsWith('/') ? file.startsWith(path) : file === path));

/**
 * Each exception the allowlist grants, so an unused one can be named: a pattern entry
 * as a whole, or one pinned digest. Labels carry the entry number and rule, never the
 * reason text, because the reason is free text that could hold a value.
 */
const exceptions = (allow: readonly AllowEntry[]) =>
  allow.flatMap((entry, i) =>
    entry.match instanceof RegExp
      ? [{ id: `${i}`, label: `entry ${i + 1} (${entry.rule})` }]
      : entry.match.sha256.map((digest, k) => ({
          id: `${i}:${digest}`,
          label: `entry ${i + 1} (${entry.rule}) digest ${k + 1}`,
        }))
  );

function excuseFor(allow: readonly AllowEntry[], rule: RuleId, file: string, value: string) {
  for (const [i, entry] of allow.entries()) {
    if (entry.rule !== rule || !coversPath(entry, file)) continue;
    if (entry.match instanceof RegExp) {
      if (entry.match.test(value)) return `${i}`;
    } else {
      const digest = sha256(value);
      if (entry.match.sha256.includes(digest)) return `${i}:${digest}`;
    }
  }
  return undefined;
}

/**
 * Finds rule hits in one file. Returns the ids of the exceptions that excused a hit,
 * so the caller can fail on exceptions that no longer excuse anything.
 */
export function scanText(file: string, text: string, allow: readonly AllowEntry[]) {
  const findings: Finding[] = [];
  const used = new Set<string>();
  text.split('\n').forEach((content, index) => {
    for (const rule of RULES) {
      for (const match of content.matchAll(rule.pattern)) {
        if (rule.accept && !rule.accept(match)) continue;
        const excuse = excuseFor(allow, rule.id, file, match[0]);
        if (excuse) used.add(excuse);
        else findings.push({ file, line: index + 1, rule: rule.id });
      }
    }
  });
  return { findings, used };
}

/** Text of a tracked file. UTF-16 is decoded from its byte order mark. Other binary is null. */
function decode(bytes: Buffer): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  }
  return bytes.subarray(0, 8000).includes(0) ? null : bytes.toString('utf8');
}

/** One line per finding. The matched text is never part of it, because it may be the secret. */
export const formatFinding = ({ file, line, rule }: Finding) =>
  `${file}:${line} ${rule} (${RULE_WHAT.get(rule)})`;

export function scanFiles(
  files: readonly string[],
  read: (file: string) => Buffer,
  allow: readonly AllowEntry[]
) {
  const findings: Finding[] = [];
  const used = new Set<string>();
  let scanned = 0;
  for (const file of files) {
    const text = decode(read(file));
    if (text === null) continue;
    scanned += 1;
    const result = scanText(file, text, allow);
    findings.push(...result.findings);
    result.used.forEach((id) => used.add(id));
  }
  const unused = exceptions(allow)
    .filter(({ id }) => !used.has(id))
    .map(({ label }) => label);
  return { findings, unused, scanned };
}

/** A symlink is stored in git as its target path, so scan that path, not the file it points at. */
export const readTracked = (file: string) =>
  lstatSync(file).isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);

if (import.meta.main) {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const { findings, unused, scanned } = scanFiles(files, readTracked, ALLOWLIST);
  for (const finding of findings) console.error(`leak-check: ${formatFinding(finding)}`);
  for (const label of unused) console.error(`leak-check: allowlist ${label} matched nothing`);
  if (findings.length > 0 || unused.length > 0) {
    console.error(
      `leak-check: ${findings.length} finding(s), ${unused.length} unused allowlist exception(s). ` +
        'Matched text is never printed. Remove the value, or add an entry with a reason to ' +
        'scripts/leak-allowlist.ts.'
    );
    process.exit(1);
  }
  console.log(`leak-check: clean, ${scanned} tracked text files scanned`);
}
