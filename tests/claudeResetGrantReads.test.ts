import { expect, test } from 'bun:test';
import {
  cardResetKey,
  cardResetReads,
  scheduleResetGrantRead,
  RESET_GRANT_READ_DELAY_MS,
} from '../src/features/quota/providers/claude/resetGrantReads';
import type { AnthropicResetGrantStatus } from '../src/services/api/claudeResetGrants';

const status: AnthropicResetGrantStatus = {
  eligible: false,
  ineligibleReason: null,
  atLimit: false,
  grants: [],
  nextGrantId: null,
  weeklyResetsAt: null,
  cooldownUntil: null,
};
test('waits 2000ms; cleanup cancels and stale sessions cannot dispatch', async () => {
  expect(RESET_GRANT_READ_DELAY_MS).toBe(2000);
  let reads = 0;
  let session = 1;
  const start = () => {
    reads += 1;
  };
  const cancel = scheduleResetGrantRead(start, () => true);
  const cancelStale = scheduleResetGrantRead(start, () => session === 1);
  const cancelActive = scheduleResetGrantRead(start, () => true);
  try {
    expect(reads).toBe(0);
    cancel(); // Effect cleanup: refresh, unmount, or connection change.
    session = 2; // Also guard a connection change before React cleanup runs.
    await Bun.sleep(1900);
    expect(reads).toBe(0);
    await Bun.sleep(200);
    expect(reads).toBe(1);
    await Bun.sleep(100);
    expect(reads).toBe(1);
  } finally {
    cancel();
    cancelStale();
    cancelActive();
  }
});

test('credential invalidation removes only that account reset snapshot', () => {
  const name = 'claude-"quoted".json';
  const key = cardResetKey(name, 'a');
  const other = cardResetKey('other.json', 'b');
  const read = { session: 1, refreshToken: null, reload: 0, readAt: 1, status };
  cardResetReads.remember(key, read);
  cardResetReads.remember(other, read);
  cardResetReads.clear([name]);
  expect(cardResetReads.known(key, 1)).toBeUndefined();
  expect(cardResetReads.known(other, 1)).toBeDefined();
  cardResetReads.clear();
  expect(cardResetReads.known(other, 1)).toBeUndefined();
});
