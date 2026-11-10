import { describe, expect, test } from 'bun:test';
import {
  formatFinding,
  scanFiles,
  scanText,
  type AllowEntry,
  type RuleId,
} from '../scripts/leak-check';

// Every fixture is assembled here from harmless parts, so this file never holds a
// value that looks like a real secret, host, or address.
const join = (...parts: string[]) => parts.join('');
const fakeHex = (length: number) => 'c0ffee'.repeat(Math.ceil(length / 6)).slice(0, length);
const fakeToken = (length: number) => 'Zq7'.repeat(Math.ceil(length / 3)).slice(0, length);

const FIXTURES: Record<RuleId, string> = {
  email: `owner: ${join('pat.doe', '@', 'mailhost', '.io')}`,
  'tailnet-host': `base_url = "https://${join('hub-box', '.tailnet-name', '.ts', '.net')}:8317"`,
  'tailnet-ip': `host: ${['100', '101', '7', '9'].join('.')}`,
  'gateway-key': `key: ${join('cpa', '-laptop-', fakeHex(48))}`,
  'gateway-env': `export ${join('CLIPROXY', 'API_', 'MGMT_KEY')}=redacted`,
  'private-key': join('-----BEGIN ', 'OPENSSH PRIVATE ', 'KEY-----'),
  'api-key': `apiKey: ${join('sk', '-proj-', fakeToken(32))}`,
  'bearer-token': `Authorization: ${join('Bear', 'er ', fakeToken(40))}`,
  'github-token': `token: ${join('gh', 'p_', fakeToken(36))}`,
};

const CLEAN = [
  "const host = '127.0.0.1';",
  'Point every client at https://<box>.<tailnet>.ts.net:8317 and keep the key private.',
  'Server listens on port 8317 and logs to /var/log/gateway.log.',
  'headers: { Authorization: `Bearer ${token}` },',
  `subnet ${['100', '63', '1', '1'].join('.')} is outside the tailnet range`,
].join('\n');

describe('leak-check rules', () => {
  test.each(Object.entries(FIXTURES) as [RuleId, string][])('%s fires', (rule, fixture) => {
    const { findings } = scanText('notes.md', `intro\n${fixture}\n`, []);
    expect(findings).toEqual([{ file: 'notes.md', line: 2, rule }]);
  });

  test('a clean file has no findings', () => {
    expect(scanText('notes.md', CLEAN, []).findings).toEqual([]);
  });
});

describe('leak-check allowlist and output', () => {
  const fakeMail = join('user', '@', 'example', '.com');
  const allowTests: AllowEntry = {
    rule: 'email',
    paths: ['tests/'],
    match: /@example\.com$/,
    reason: 'reserved domain',
  };

  test('an entry excuses its rule only inside its paths', () => {
    const files = { 'tests/a.test.ts': fakeMail, 'src/a.ts': fakeMail };
    const result = scanFiles(
      Object.keys(files),
      (file) => Buffer.from(files[file as keyof typeof files]),
      [allowTests]
    );
    expect(result.findings).toEqual([{ file: 'src/a.ts', line: 1, rule: 'email' }]);
    expect(result.unused).toEqual([]);
  });

  test('an entry that excuses nothing is reported as unused', () => {
    const result = scanFiles(['src/a.ts'], () => Buffer.from('clean'), [allowTests]);
    expect(result.unused).toEqual([allowTests]);
  });

  test('the report names file, line, and rule but never the matched text', () => {
    const fixture = FIXTURES['api-key'];
    const [finding] = scanText('src/config.ts', fixture, []).findings;
    const line = formatFinding(finding);
    expect(line).toBe('src/config.ts:1 api-key (sk- style API key)');
    expect(line).not.toContain(fixture.slice('apiKey: '.length));
  });
});
