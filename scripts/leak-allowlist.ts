import type { AllowEntry } from './leak-check';

/**
 * Every exception to the leak check. Keep it short. Each entry names the rule,
 * the files it covers, what it lets through, and why that value is safe.
 * leak-check fails when an entry stops matching anything, so dead entries cannot pile up.
 */
export const ALLOWLIST: readonly AllowEntry[] = [
  {
    rule: 'email',
    paths: ['tests/'],
    match:
      /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|[a-z0-9-]+\.(?:test|invalid|example|localhost))(?:-[a-z]+)?(?:\.json)?$/i,
    reason: 'RFC 2606 and RFC 6761 reserve these domains, so test accounts on them are fake.',
  },
  {
    rule: 'email',
    paths: ['tests/authFilesListLogic.test.ts', 'tests/authFileIdentity.test.ts'],
    match: /^[a-z0-9+-]+@x\.com(?:-[a-z]+)?(?:\.json)?$/i,
    reason:
      'Upstream auth-file fixtures use one-letter fake mailboxes. Editing upstream tests would conflict on every upstream sync.',
  },
  {
    rule: 'email',
    paths: ['tests/authFileIdentity.test.ts'],
    match: /^sa@project\.iam\.gserviceaccount\.com$/,
    reason: 'Upstream Vertex fixture names a fake service account in a project called "project".',
  },
  {
    rule: 'api-key',
    paths: ['tests/apiKeyStrength.test.ts', 'tests/apiKeyNames.test.ts'],
    match: {
      sha256: [
        'a4436ec88963d66c0ff80d7eebcd48354dd3d4bd1b4436cb02e6c8166e9b9e77',
        'a4f9cad487793d06f0b71c3b670d384a5d22146c6deaf205ea592597ee201db1',
        'a10c58d29b30adc4529263efb6eda7f62e6f37abbb91d902cf863d309a70bf24',
        '97f9fbdacfddbe9bb05536e9bef4f4c524288bb31b387844e85a41388bc12e0b',
        'a3581366ea504ecb40decc35e5e9e1efb59defe652806be34688f8b924a04627',
      ],
    },
    reason:
      'Upstream key-strength and key-name tests need sk- shaped fake keys. Each is pinned by digest, so a new key in these files still fails.',
  },
];
