import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isRecord } from '@/utils/helpers';

const root = resolve(import.meta.dir, '../..');
const scratch = mkdtempSync(join(tmpdir(), 'quota-visibility-'));
const checker = 'verification/quota-visibility/check.ts';

type Report = { passed: Set<string>; failed: Set<string> };

function report(output: string): Report {
  const value: unknown = JSON.parse(output);
  assert(isRecord(value) && Array.isArray(value.results), 'Invalid checker report');
  const passed = new Set<string>();
  const failed = new Set<string>();
  for (const result of value.results) {
    assert(isRecord(result) && Array.isArray(result.properties), 'Invalid scenario result');
    const scenario = `${result.credentials} credentials, remember ${result.rememberPassword}`;
    for (const property of result.properties) {
      assert(isRecord(property) && typeof property.id === 'string', 'Invalid property result');
      (property.counterexample === null ? passed : failed).add(`${scenario}: ${property.id}`);
    }
  }
  return { passed, failed };
}

function check(): Report {
  const result = Bun.spawnSync([process.execPath, checker], { cwd: scratch });
  const stdout = result.stdout.toString();
  assert((result.exitCode === 0 || result.exitCode === 1) && stdout, result.stderr.toString());
  return report(stdout);
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
  const caught = new Set<string>();
  for (const mutation of mutations) {
    const targets = [...baseline.passed].filter((pair) => pair.endsWith(`: ${mutation.property}`));
    assert(targets.length, `Baseline already fails ${mutation.property} everywhere`);
    const path = join(scratch, mutation.file);
    const source = readFileSync(path, 'utf8');
    assert.equal(
      source.split(mutation.before).length,
      2,
      `Mutation anchor changed in ${mutation.file}`
    );
    writeFileSync(path, source.replace(mutation.before, mutation.after));
    try {
      const { failed } = check();
      const missed = targets.filter((pair) => !failed.has(pair));
      assert.deepEqual(missed, [], `Checker missed the product mutation in ${mutation.file}`);
      for (const pair of failed) if (baseline.passed.has(pair)) caught.add(pair);
      console.log(`Caught ${mutation.property} after changing ${mutation.file}`);
    } finally {
      writeFileSync(path, source);
    }
  }
  // Without a remembered password nothing is saved, so this pass is vacuous, not mutation-proven.
  const vacuous = ['1 credentials, remember false: SAVED_VALUES_SURVIVE_RELOAD'];
  assert.deepEqual(
    [...baseline.passed].filter((pair) => !caught.has(pair)).sort(),
    vacuous,
    'A passing property has no product mutation that breaks it'
  );
  assert.deepEqual(
    [...check().failed].sort(),
    [...baseline.failed].sort(),
    'Restored source changed the baseline'
  );
  console.log(`Vacuous passes: ${vacuous.join(', ')}`);
  console.log(`Restored source. Existing findings: ${[...baseline.failed].sort().join(', ')}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
