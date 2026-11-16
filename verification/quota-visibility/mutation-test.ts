import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isRecord } from '@/utils/helpers';

const root = resolve(import.meta.dir, '../..');
const scratch = mkdtempSync(join(tmpdir(), 'quota-visibility-'));
const checker = 'verification/quota-visibility/check.ts';

function failures(output: string): Set<string> {
  const value: unknown = JSON.parse(output);
  assert(isRecord(value) && Array.isArray(value.results), 'Invalid checker report');
  const failed = new Set<string>();
  for (const result of value.results) {
    assert(isRecord(result) && Array.isArray(result.properties), 'Invalid scenario result');
    for (const property of result.properties) {
      assert(isRecord(property) && typeof property.id === 'string', 'Invalid property result');
      if (property.counterexample !== null) failed.add(property.id);
    }
  }
  return failed;
}

function check(): Set<string> {
  const result = Bun.spawnSync([process.execPath, checker], { cwd: scratch });
  assert(result.exitCode === 0 || result.exitCode === 1, result.stderr.toString());
  return failures(result.stdout.toString());
}

try {
  cpSync(join(root, 'src'), join(scratch, 'src'), { recursive: true });
  cpSync(
    join(root, 'verification/quota-visibility'),
    join(scratch, 'verification/quota-visibility'),
    { recursive: true }
  );
  cpSync(join(root, 'tsconfig.json'), join(scratch, 'tsconfig.json'));
  cpSync(join(root, 'package.json'), join(scratch, 'package.json'));
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  const baseline = check();
  const mutations = [
    {
      file: 'src/stores/useQuotaStore.ts',
      before: '          previous &&',
      after: '          false && previous &&',
      property: 'KNOWN_VALUES_RETAINED',
    },
    {
      file: 'src/features/quota/ledger/LedgerPanel.tsx',
      before: '          {statusText}\n        </td>',
      after: '          {statusText} 0% left\n        </td>',
      property: 'NO_INVENTED_QUOTA',
    },
  ];
  for (const mutation of mutations) {
    assert(!baseline.has(mutation.property), `Baseline already fails ${mutation.property}`);
    const path = join(scratch, mutation.file);
    const source = readFileSync(path, 'utf8');
    assert.equal(
      source.split(mutation.before).length,
      2,
      `Mutation anchor changed in ${mutation.file}`
    );
    writeFileSync(path, source.replace(mutation.before, mutation.after));
    try {
      assert(
        check().has(mutation.property),
        `Checker missed the product mutation in ${mutation.file}`
      );
      console.log(`Caught ${mutation.property} after changing ${mutation.file}`);
    } finally {
      writeFileSync(path, source);
    }
  }
  assert.deepEqual(
    [...check()].sort(),
    [...baseline].sort(),
    'Restored source changed the baseline'
  );
  console.log(`Restored source. Existing findings: ${[...baseline].sort().join(', ')}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
