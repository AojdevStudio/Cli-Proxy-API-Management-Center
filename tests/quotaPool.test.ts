import { describe, expect, test } from 'bun:test';
import {
  poolCredentialOf,
  projectPool,
  summarizePool,
  type PoolCredential,
} from '@/features/quota/pool';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';

const now = Date.UTC(2026, 10, 10, 12);
const WEEK_MS = 7 * DAY_MS;

const credential = (
  name: string,
  leftPercent: number,
  resetInMs: number,
  periodMs = WEEK_MS
): PoolCredential => ({ id: name, name, leftPercent, resetAtMs: now + resetInMs, periodMs });

const weekly = (usedPercent: number | null, resetInMs: number | null, id = 'seven-day') => ({
  id,
  usedPercent,
  resetAtMs: resetInMs === null ? null : now + resetInMs,
  periodHours: 168,
});

describe('poolCredentialOf', () => {
  test('reads the provider weekly window as percent left', () => {
    expect(
      poolCredentialOf('claude', 'claude-1.json', 'claude-1', [
        weekly(36, 2 * HOUR_MS, 'five-hour'),
        weekly(69, 19 * HOUR_MS),
      ])
    ).toEqual({
      id: 'claude-1.json',
      name: 'claude-1',
      leftPercent: 31,
      resetAtMs: now + 19 * HOUR_MS,
      periodMs: WEEK_MS,
    });
    expect(
      poolCredentialOf('codex', 'codex-1.json', 'codex-1', [weekly(53, DAY_MS, 'weekly')])
        ?.leftPercent
    ).toBe(47);
  });

  test('skips a credential whose weekly window has not loaded', () => {
    expect(poolCredentialOf('claude', 'a', 'a', [])).toBeNull();
    expect(poolCredentialOf('claude', 'a', 'a', [weekly(null, DAY_MS)])).toBeNull();
    expect(poolCredentialOf('claude', 'a', 'a', [weekly(20, null)])).toBeNull();
    expect(poolCredentialOf('codex', 'a', 'a', [weekly(20, DAY_MS, 'seven-day')])).toBeNull();
  });
});

describe('summarizePool', () => {
  const claude = [
    credential('claude-1', 31, 19 * HOUR_MS),
    credential('claude-2', 86, 2 * DAY_MS + 10 * HOUR_MS),
    credential('claude-3', 11, 4 * DAY_MS + 20 * HOUR_MS),
  ];

  test('sums weekly percent left against a cap of 100 per loaded credential', () => {
    const summary = summarizePool(claude, 1);
    expect(summary.poolPercent).toBe(128);
    expect(summary.capPercent).toBe(300);
    expect(summary.skippedCount).toBe(1);
  });

  test('next reset is the soonest weekly reset and gains what that credential used', () => {
    const summary = summarizePool([...claude].reverse(), 0);
    expect(summary.nextReset).toEqual({
      atMs: now + 19 * HOUR_MS,
      name: 'claude-1',
      gainPercent: 69,
    });
  });

  test('an empty pool has no cap and no next reset', () => {
    expect(summarizePool([], 2)).toEqual({
      credentials: [],
      skippedCount: 2,
      poolPercent: 0,
      capPercent: 0,
      nextReset: null,
    });
  });
});

describe('projectPool', () => {
  test('without burn the pool steps up at each reset and resets repeat weekly', () => {
    const projection = projectPool(
      [credential('a', 31, 19 * HOUR_MS), credential('b', 86, 2 * DAY_MS)],
      { nowMs: now, endMs: now + 10 * DAY_MS, burnPercentPerHour: 0 }
    );

    expect(projection.steps).toEqual([
      { atMs: now + 19 * HOUR_MS, name: 'a', gainPercent: 69, poolPercent: 186 },
      { atMs: now + 2 * DAY_MS, name: 'b', gainPercent: 14, poolPercent: 200 },
      { atMs: now + 19 * HOUR_MS + WEEK_MS, name: 'a', gainPercent: 0, poolPercent: 200 },
      { atMs: now + 2 * DAY_MS + WEEK_MS, name: 'b', gainPercent: 0, poolPercent: 200 },
    ]);
    expect(projection.points[0]).toEqual({ atMs: now, poolPercent: 117 });
    expect(projection.points.at(-1)).toEqual({ atMs: now + 10 * DAY_MS, poolPercent: 200 });
    expect(projection.firstEmpty).toBeNull();
    expect(projection.poolEmptyMs).toBeNull();
  });

  test('burn draws from the credential that resets soonest first', () => {
    const projection = projectPool(
      [credential('later', 50, 100 * HOUR_MS), credential('sooner', 50, 10 * HOUR_MS)],
      { nowMs: now, endMs: now + 20 * HOUR_MS, burnPercentPerHour: 2 }
    );

    // Ten hours at 2%/h come out of `sooner` alone, so its reset gains 70.
    expect(projection.steps[0]).toEqual({
      atMs: now + 10 * HOUR_MS,
      name: 'sooner',
      gainPercent: 70,
      poolPercent: 150,
    });
    // After that reset `sooner` is next due in a week, so `later` burns next.
    expect(projection.points.at(-1)).toEqual({ atMs: now + 20 * HOUR_MS, poolPercent: 130 });
  });

  test('first empty and pool empty follow the burn, and a reset refills the pool', () => {
    const projection = projectPool(
      [credential('a', 10, 48 * HOUR_MS), credential('b', 20, 72 * HOUR_MS)],
      { nowMs: now, endMs: now + 60 * HOUR_MS, burnPercentPerHour: 5 }
    );

    expect(projection.firstEmpty).toEqual({ atMs: now + 2 * HOUR_MS, name: 'a' });
    expect(projection.poolEmptyMs).toBe(now + 6 * HOUR_MS);
    expect(projection.points).toContainEqual({ atMs: now + 6 * HOUR_MS, poolPercent: 0 });
    expect(projection.steps[0]).toEqual({
      atMs: now + 48 * HOUR_MS,
      name: 'a',
      gainPercent: 100,
      poolPercent: 100,
    });
    expect(projection.points.at(-1)).toEqual({ atMs: now + 60 * HOUR_MS, poolPercent: 40 });
  });

  test('burned-down credentials refill again on every weekly reset', () => {
    const projection = projectPool([credential('a', 100, DAY_MS)], {
      nowMs: now,
      endMs: now + 20 * DAY_MS,
      burnPercentPerHour: 0.5,
    });

    expect(projection.steps.map((step) => [step.atMs - now, step.gainPercent])).toEqual([
      [DAY_MS, 12],
      [DAY_MS + WEEK_MS, 84],
      [DAY_MS + 2 * WEEK_MS, 84],
    ]);
    expect(projection.firstEmpty).toBeNull();
  });
});
