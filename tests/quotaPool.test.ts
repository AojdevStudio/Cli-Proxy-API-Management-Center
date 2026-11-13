import { describe, expect, test } from 'bun:test';
import type { QuotaHistory } from '@/features/quota/history';
import { ledgerPool, toLedgerEntry } from '@/features/quota/ledger/ledgerModel';
import { forecastPool, weekPager } from '@/features/quota/ledger/poolControls';
import {
  POOL_MODELS,
  emptyWithin,
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
): PoolCredential => ({
  id: name,
  name,
  authIndex: `fake-${name}`,
  leftPercent,
  resetAtMs: now + resetInMs,
  periodMs,
});

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

const login = (id: string, name = id) => ({ id, name, authIndex: `fake-${id}` });

describe('poolCredentialOf', () => {
  test('reads the named window as percent left', () => {
    expect(
      poolCredentialOf('seven-day', login('claude-1.json', 'claude-1'), [
        weekly(36, 2 * HOUR_MS, 'five-hour'),
        weekly(69, 19 * HOUR_MS),
      ])
    ).toEqual({
      id: 'claude-1.json',
      name: 'claude-1',
      authIndex: 'fake-claude-1.json',
      leftPercent: 31,
      resetAtMs: now + 19 * HOUR_MS,
      periodMs: WEEK_MS,
    });
    expect(
      poolCredentialOf('weekly', login('codex-1.json', 'codex-1'), [weekly(53, DAY_MS, 'weekly')])
        ?.leftPercent
    ).toBe(47);
  });

  test('skips a credential whose weekly window has not loaded', () => {
    expect(poolCredentialOf('seven-day', login('a'), [])).toBeNull();
    expect(poolCredentialOf('seven-day', login('a'), [weekly(null, DAY_MS)])).toBeNull();
    expect(poolCredentialOf('weekly', login('a'), [weekly(20, DAY_MS, 'seven-day')])).toBeNull();
  });

  test('keeps a loaded weekly limit that reports no reset time', () => {
    expect(poolCredentialOf('seven-day', login('a'), [weekly(20, null)])).toEqual({
      id: 'a',
      name: 'a',
      authIndex: 'fake-a',
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

describe('emptyWithin', () => {
  const points = [
    { atMs: now, poolPercent: 20 },
    { atMs: now + DAY_MS, poolPercent: 0 },
    { atMs: now + 2 * DAY_MS, poolPercent: 0 },
    { atMs: now + 2 * DAY_MS, poolPercent: 100 },
    { atMs: now + 9 * DAY_MS, poolPercent: 0 },
  ];

  test('finds the first time the pool runs dry inside the span, not only the first ever', () => {
    expect(emptyWithin(points, now, now + 3 * DAY_MS)).toBe(now + DAY_MS);
    expect(emptyWithin(points, now + 3 * DAY_MS, now + 17 * DAY_MS)).toBe(now + 9 * DAY_MS);
  });

  test('is null when the span opens on a pool that is already empty and stays so', () => {
    expect(emptyWithin(points, now + 30 * HOUR_MS, now + 40 * HOUR_MS)).toBeNull();
  });

  test('marks now when the path starts empty', () => {
    expect(emptyWithin([{ atMs: now, poolPercent: 0 }], now, now + DAY_MS)).toBe(now);
  });
});

describe('pool controls', () => {
  const span = { startMs: now - DAY_MS, endMs: now + 10 * DAY_MS };
  const steadyHistory = (names: readonly string[]): QuotaHistory => ({
    provider: 'claude',
    range: '14d',
    fromMs: now - 14 * DAY_MS,
    toMs: now,
    logins: new Map(
      names.map((name) => [
        `fake-${name}`,
        {
          readings: [
            {
              observedAtMs: now - 4 * HOUR_MS,
              confirmedAtMs: now - 4 * HOUR_MS,
              usedPercent: 10,
              resetAtMs: now + 3 * DAY_MS,
            },
            {
              observedAtMs: now - 30 * MINUTE_MS,
              confirmedAtMs: now,
              usedPercent: 16,
              resetAtMs: now + 3 * DAY_MS,
            },
          ],
          gaps: [],
        },
      ])
    ),
  });

  test('Double future usage empties the pool earlier than Same as now', () => {
    const credentials = [credential('a', 90, 3 * DAY_MS), credential('b', 84, 3 * DAY_MS)];
    const forecast = (futureUsage: 'same' | 'double') =>
      forecastPool({
        credentials,
        recordedByReader: true,
        history: steadyHistory(['a', 'b']),
        controls: { burnWindowHours: 3, futureUsage },
        span,
        nowMs: now,
      });
    const same = forecast('same');
    const double = forecast('double');

    expect(same.burnPercentPerHour).toBeCloseTo(4);
    expect(double.projectedPercentPerHour).toBeCloseTo(8);
    expect(same.projection?.poolEmptyMs).toBe(now + 43.5 * HOUR_MS);
    expect(double.projection?.poolEmptyMs).toBe(now + 21.75 * HOUR_MS);
  });

  test('the pager stops one week back at the 14-day history limit and two weeks ahead', () => {
    expect(weekPager(0, now)).toEqual({ earlier: true, later: true, today: false });
    expect(weekPager(-1, now)).toEqual({ earlier: false, later: true, today: true });
    expect(weekPager(1, now).later).toBe(true);
    expect(weekPager(2, now)).toEqual({ earlier: true, later: false, today: true });
  });

  test('the Fable pool sums each login seven-day-fable window and its projection never drains', () => {
    const windows = (allUsed: number, fableUsed: number) => [
      { id: 'seven-day', usedPercent: allUsed, resetAtMs: now + DAY_MS, periodHours: 168 },
      { id: 'seven-day-fable', usedPercent: fableUsed, resetAtMs: now + DAY_MS, periodHours: 168 },
    ];
    const ledgers = [windows(69, 42), windows(14, 9)].map((quotaWindows, index) => {
      const ledger = toLedgerEntry(
        {
          file: { name: `claude-${index}.json`, type: 'claude', authIndex: `fake-${index}` },
          type: 'claude',
        },
        {
          status: 'success',
          windows: quotaWindows.map((w) => ({ ...w, label: '', resetLabel: '' })),
        }
      );
      if (!ledger) throw new Error('claude entry expected');
      return ledger;
    });
    const [, fable] = POOL_MODELS.claude;
    const pool = ledgerPool(ledgers, fable.windowId, now);
    expect(pool.poolPercent).toBe(149);

    const forecast = forecastPool({
      credentials: pool.credentials,
      recordedByReader: fable.recorded,
      history: steadyHistory(['claude-0.json', 'claude-1.json']),
      controls: { burnWindowHours: 3, futureUsage: 'double' },
      span,
      nowMs: now,
    });
    expect(forecast.burnPercentPerHour).toBeNull();
    expect(forecast.recorded).toEqual([]);
    const levels = forecast.projection?.points.map((point) => point.poolPercent) ?? [];
    expect(levels[0]).toBe(149);
    expect(levels.every((level, index) => index === 0 || level >= levels[index - 1])).toBe(true);
    expect(forecast.projection?.poolEmptyMs).toBeNull();
  });
});
