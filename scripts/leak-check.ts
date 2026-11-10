import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

export const RULES: readonly Rule[] = [
  {
    id: 'email',
    what: 'email address',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
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
    pattern: /\bCLIPROXYAPI_[A-Z0-9_]+/g,
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
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
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

const coversValue = (entry: AllowEntry, value: string) =>
  entry.match instanceof RegExp
    ? entry.match.test(value)
    : entry.match.sha256.includes(sha256(value));

/**
 * Finds rule hits in one file. Returns the allowlist entries that excused a hit,
 * so the caller can fail on entries that no longer excuse anything.
 */
export function scanText(file: string, text: string, allow: readonly AllowEntry[]) {
  const findings: Finding[] = [];
  const used = new Set<AllowEntry>();
  text.split('\n').forEach((content, index) => {
    for (const rule of RULES) {
      for (const match of content.matchAll(rule.pattern)) {
        if (rule.accept && !rule.accept(match)) continue;
        const excuse = allow.find(
          (entry) =>
            entry.rule === rule.id && coversPath(entry, file) && coversValue(entry, match[0])
        );
        if (excuse) used.add(excuse);
        else findings.push({ file, line: index + 1, rule: rule.id });
      }
    }
  });
  return { findings, used };
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
  const used = new Set<AllowEntry>();
  let scanned = 0;
  for (const file of files) {
    const bytes = read(file);
    if (bytes.subarray(0, 8000).includes(0)) continue;
    scanned += 1;
    const result = scanText(file, bytes.toString('utf8'), allow);
    findings.push(...result.findings);
    result.used.forEach((entry) => used.add(entry));
  }
  const unused = allow.filter((entry) => !used.has(entry));
  return { findings, unused, scanned };
}

if (import.meta.main) {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const { findings, unused, scanned } = scanFiles(files, (file) => readFileSync(file), ALLOWLIST);
  for (const finding of findings) console.error(`leak-check: ${formatFinding(finding)}`);
  for (const entry of unused) {
    console.error(
      `leak-check: allowlist entry for ${entry.rule} matched nothing (${entry.reason})`
    );
  }
  if (findings.length > 0 || unused.length > 0) {
    console.error(
      `leak-check: ${findings.length} finding(s), ${unused.length} unused allowlist entr(ies). ` +
        'Matched text is never printed. Remove the value, or add an entry with a reason to ' +
        'scripts/leak-allowlist.ts.'
    );
    process.exit(1);
  }
  console.log(`leak-check: clean, ${scanned} tracked text files scanned`);
}
