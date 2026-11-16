import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import { claudeReservationApi, isReservedClaudeAccount } from '@/services/api/claudeReservation';
import type { AuthFileItem } from '@/types';

const file: AuthFileItem = { name: 'claude-9ef827e2-test.json', type: 'claude' };
const client = apiClient.captureConnection();
const capture = spyOn(apiClient, 'captureConnection');
const download = spyOn(client, 'get');
const patch = spyOn(client, 'patch');
const metadata = (fullAccess = false, exclusions = ['claude-*']) =>
  new Blob([
    JSON.stringify({
      quota_priority_full_access: fullAccess,
      quota_priority_reserve_excluded_models: exclusions,
      access_token: 'private-test-value',
    }),
  ]);
const revision = () => apiClient.getConnectionRevision();

beforeEach(() => {
  capture.mockReturnValue(client);
  download.mockResolvedValue(metadata());
  patch.mockResolvedValue({ status: 'ok', access_token: 'private-test-value' });
});

afterEach(() => {
  capture.mockClear();
  download.mockReset();
  patch.mockReset();
});

afterAll(() => {
  capture.mockRestore();
  download.mockRestore();
  patch.mockRestore();
});

test('only the approved Claude account has a reservation control', () => {
  expect(isReservedClaudeAccount(file)).toBe(true);
  expect(isReservedClaudeAccount({ ...file, type: 'codex' })).toBe(false);
  expect(isReservedClaudeAccount({ ...file, name: 'claude-other.json' })).toBe(false);
});

test('reads only typed reservation metadata and defaults a missing mode to reserve', async () => {
  download.mockResolvedValueOnce(metadata(true));
  expect(await claudeReservationApi.read(file, revision())).toEqual({
    fullAccess: true,
    reserveExcludedModels: ['claude-*'],
  });
  download.mockResolvedValueOnce(
    new Blob([JSON.stringify({ quota_priority_reserve_excluded_models: [] })])
  );
  expect(await claudeReservationApi.read(file, revision())).toEqual({
    fullAccess: false,
    reserveExcludedModels: [],
  });
  expect(download.mock.calls[0]).toEqual([
    '/credentials/download?name=claude-9ef827e2-test.json',
    { responseType: 'blob' },
  ]);
});

test('missing or malformed reserve metadata never enables a write', async () => {
  for (const value of [
    {},
    { quota_priority_reserve_excluded_models: null },
    { quota_priority_reserve_excluded_models: ['claude-*', 1] },
    { quota_priority_reserve_excluded_models: [''] },
    { quota_priority_reserve_excluded_models: [], quota_priority_full_access: 'true' },
    { quota_priority_reserve_excluded_models: [], quota_priority_full_access: null },
  ]) {
    download.mockResolvedValueOnce(new Blob([JSON.stringify(value)]));
    await expect(claudeReservationApi.setFullAccess(file, true, revision())).rejects.toMatchObject({
      code: 'unsupported',
    });
  }
  expect(patch).not.toHaveBeenCalled();
});

test('enables atomically and restores the latest job-provided exclusions without returning secrets', async () => {
  expect(await claudeReservationApi.setFullAccess(file, true, revision())).toEqual({
    fullAccess: true,
    reserveExcludedModels: ['claude-*'],
  });
  download.mockResolvedValueOnce(metadata(true, ['claude-fable-*']));
  expect(await claudeReservationApi.setFullAccess(file, false, revision())).toEqual({
    fullAccess: false,
    reserveExcludedModels: ['claude-fable-*'],
  });
  expect(patch.mock.calls).toEqual([
    [
      '/credentials/fields',
      { name: file.name, quota_priority_full_access: true, excluded_models: [] },
    ],
    [
      '/credentials/fields',
      {
        name: file.name,
        quota_priority_full_access: false,
        excluded_models: ['claude-fable-*'],
      },
    ],
  ]);
});

test('rejects other accounts and stale or replaced credential work before dispatching a patch', async () => {
  await expect(
    claudeReservationApi.setFullAccess({ ...file, type: 'codex' }, true, revision())
  ).rejects.toMatchObject({ code: 'identity' });
  await expect(claudeReservationApi.read(file, revision() - 1)).rejects.toMatchObject({
    code: 'stale',
  });
  let current = true;
  download.mockImplementationOnce(async () => {
    current = false;
    return metadata();
  });
  await expect(
    claudeReservationApi.setFullAccess(file, true, revision(), () => current)
  ).rejects.toMatchObject({ code: 'stale' });
  expect(patch).not.toHaveBeenCalled();
});

test('an ABA connection switch during preflight refuses the write', async () => {
  const original = revision();
  download.mockImplementationOnce(async () => {
    apiClient.setConfig({ apiBase: 'https://reservation-test.invalid', managementKey: '' });
    apiClient.setConfig({ apiBase: '', managementKey: '' });
    return metadata();
  });
  await expect(claudeReservationApi.setFullAccess(file, true, original)).rejects.toMatchObject({
    code: 'stale',
  });
  expect(patch).not.toHaveBeenCalled();
});

test('late reads and completed writes cannot update a replacement credential scope', async () => {
  let current = true;
  download.mockImplementationOnce(async () => {
    current = false;
    return metadata();
  });
  await expect(claudeReservationApi.read(file, revision(), () => current)).rejects.toMatchObject({
    code: 'stale',
  });
  current = true;
  patch.mockImplementationOnce(async () => {
    current = false;
    return { status: 'ok' };
  });
  await expect(
    claudeReservationApi.setFullAccess(file, true, revision(), () => current)
  ).rejects.toMatchObject({ code: 'stale' });
});

test('double clicks cannot dispatch two writes and failure allows a fresh retry', async () => {
  const pending = Promise.withResolvers<Blob>();
  download.mockReturnValueOnce(pending.promise);
  const first = claudeReservationApi.setFullAccess(file, true, revision());
  await expect(claudeReservationApi.setFullAccess(file, true, revision())).rejects.toMatchObject({
    code: 'busy',
  });
  pending.resolve(metadata());
  await first;
  expect(patch).toHaveBeenCalledTimes(1);
  patch.mockRejectedValueOnce(new Error('private-test-value'));
  await expect(claudeReservationApi.setFullAccess(file, false, revision())).rejects.toMatchObject({
    code: 'write_failed',
    message: 'Claude reservation failed (write_failed)',
  });
  await claudeReservationApi.setFullAccess(file, false, revision());
  expect(patch).toHaveBeenCalledTimes(3);
});

test('read and JSON errors expose only a safe error code', async () => {
  for (const value of [new Blob(['private-test-value']), new Error('private-test-value')]) {
    if (value instanceof Error) download.mockRejectedValueOnce(value);
    else download.mockResolvedValueOnce(value);
    await expect(claudeReservationApi.read(file, revision())).rejects.toMatchObject({
      code: 'read_failed',
      message: 'Claude reservation failed (read_failed)',
    });
  }
});
