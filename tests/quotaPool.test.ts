import { describe, expect, test } from 'bun:test';
import {
  poolCredentialOf,
  poolLevelAt,
  projectPool,
  summarizePool,
  type PoolCredential,
} from '@/features/quota/pool';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

const now = Date.UTC(2026, 10, 10, 12);
const WEEK_MS = 7 * DAY_MS;

const credential = (
  name: string,
  leftPercent: number,
  resetInMs: number,
  periodMs = WEEK_MS
): PoolCredential => ({ id: name, name, leftPercent, resetAtMs: now + resetInMs, periodMs });

/** A loaded login whose backend reported no reset time. */
const unscheduled = (name: string, leftPercent: number): PoolCredential => ({
  ...credential(name, leftPercent, 0),
  resetAtMs: null,
});

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
    expect(poolCredentialOf('codex', 'a', 'a', [weekly(20, DAY_MS, 'seven-day')])).toBeNull();
  });

  test('keeps a loaded weekly limit that reports no reset time', () => {
    expect(poolCredentialOf('claude', 'a', 'a', [weekly(20, null)])).toEqual({
      id: 'a',
      name: 'a',
      leftPercent: 80,
      resetAtMs: null,
      periodMs: WEEK_MS,
    });
  });
});

describe('summarizePool', () => {
  const claude = [
    credential('claude-1', 31, 19 * HOUR_MS),
    credential('claude-2', 86, 2 * DAY_MS + 10 * HOUR_MS),
    credential('claude-3', 11, 4 * DAY_MS + 20 * HOUR_MS),
  ];

  test('sums weekly percent left against a cap of 100 per loaded credential', () => {
    const summary = summarizePool(claude, 1, now);
    expect(summary.poolPercent).toBe(128);
    expect(summary.capPercent).toBe(300);
    expect(summary.skippedCount).toBe(1);
  });

  test('next reset is the soonest weekly reset and gains what that credential used', () => {
    const summary = summarizePool([...claude].reverse(), 0, now);
    expect(summary.nextReset).toEqual({
      atMs: now + 19 * HOUR_MS,
      name: 'claude-1',
      gainPercent: 69,
    });
  });

  test('a reset at or before now has refilled its login, and the next reset is still ahead', () => {
    const summary = summarizePool(
      [
        credential('due', 0, -(WEEK_MS + HOUR_MS)),
        credential('edge', 50, 0),
        credential('later', 40, WEEK_MS),
      ],
      0,
      now
    );
    expect(summary.poolPercent).toBe(240);
    expect(summary.nextReset).toEqual({
      atMs: now + WEEK_MS - HOUR_MS,
      name: 'due',
      gainPercent: 0,
    });
  });

  test('a login with no reset time counts in the pool but never as the next reset', () => {
    const summary = summarizePool(
      [unscheduled('unknown', 80), credential('b', 30, DAY_MS)],
      0,
      now
    );
    expect(summary.poolPercent).toBe(110);
    expect(summary.capPercent).toBe(200);
    expect(summary.nextReset).toEqual({ atMs: now + DAY_MS, name: 'b', gainPercent: 70 });
  });

  test('an empty pool has no cap and no next reset', () => {
    expect(summarizePool([], 2, now)).toEqual({
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

  test('a reset that is already due refills now and next comes back on its period', () => {
    const projection = projectPool([credential('due', 0, -(WEEK_MS + HOUR_MS))], {
      nowMs: now,
      endMs: now + 10 * DAY_MS,
      burnPercentPerHour: 0,
    });

    expect(projection.points[0]).toEqual({ atMs: now, poolPercent: 100 });
    expect(projection.steps).toEqual([
      { atMs: now + WEEK_MS - HOUR_MS, name: 'due', gainPercent: 0, poolPercent: 100 },
    ]);
    expect(projection.firstEmpty).toBeNull();
    expect(projection.poolEmptyMs).toBeNull();
  });

  test('a login with no reset time adds its quota but no reset steps', () => {
    const projection = projectPool([unscheduled('unknown', 80), credential('b', 30, DAY_MS)], {
      nowMs: now,
      endMs: now + 10 * DAY_MS,
      burnPercentPerHour: 0,
    });

    expect(projection.points[0]).toEqual({ atMs: now, poolPercent: 110 });
    expect(projection.steps.map((step) => [step.name, step.atMs - now])).toEqual([
      ['b', DAY_MS],
      ['b', DAY_MS + WEEK_MS],
    ]);
  });
});

describe('poolLevelAt', () => {
  test('a time before the path starts reads the first level, not NaN', () => {
    const points = [
      { atMs: now, poolPercent: 117 },
      { atMs: now + HOUR_MS, poolPercent: 100 },
    ];
    expect(poolLevelAt(points, now - MINUTE_MS)).toBe(117);
  });
});
