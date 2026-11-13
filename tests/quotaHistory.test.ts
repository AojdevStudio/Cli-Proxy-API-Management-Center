import { describe, expect, test } from 'bun:test';
import {
  burnOverWindow,
  drainSeries,
  recordedLevelAt,
  recordedPool,
} from '@/features/quota/history';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import { NOW, account, historyBody, observation, parseHistory } from './fixtures/quotaHistory';

const RESET = NOW + 3 * DAY_MS;
const member = (authIndex: string | null) => ({ authIndex });

describe('recordedPool', () => {
  test('sums each login in force by auth index, whatever order the pool lists them in', async () => {
    const history = await parseHistory(
      historyBody([
        account('fake-a', [
          observation(NOW - 30 * HOUR_MS, 0.2, RESET),
          observation(NOW - 4 * HOUR_MS, 0.5, RESET),
        ]),
        account('fake-b', [observation(NOW - 20 * HOUR_MS, 0.1, RESET)]),
      ])
    );
    const segments = recordedPool(
      history,
      [member('fake-b'), member('fake-a')],
      NOW - 12 * HOUR_MS,
      NOW
    );

    expect(segments.map((segment) => segment.points)).toEqual([
      [
        { atMs: NOW - 12 * HOUR_MS, poolPercent: 170 },
        { atMs: NOW - 4 * HOUR_MS, poolPercent: 170 },
        { atMs: NOW - 4 * HOUR_MS, poolPercent: 140 },
        { atMs: NOW, poolPercent: 140 },
      ],
    ]);
    expect(recordedLevelAt(segments, NOW - 5 * HOUR_MS)).toBe(170);
    expect(recordedLevelAt(segments, NOW - 4 * HOUR_MS)).toBe(140);
  });

  test('starts at the range start from the reading in force before it', async () => {
    const history = await parseHistory(
      historyBody(
        [
          account('fake-a', [
            observation(NOW - 30 * HOUR_MS, 0.2, RESET),
            observation(NOW - 2 * HOUR_MS, 0.4, RESET),
          ]),
        ],
        { range: '24h' }
      )
    );

    expect(
      recordedPool(history, [member('fake-a')], NOW - 2 * DAY_MS, NOW).map(
        (segment) => segment.points
      )
    ).toEqual([
      [
        { atMs: NOW - DAY_MS, poolPercent: 80 },
        { atMs: NOW - 2 * HOUR_MS, poolPercent: 80 },
        { atMs: NOW - 2 * HOUR_MS, poolPercent: 60 },
        { atMs: NOW, poolPercent: 60 },
      ],
    ]);
  });

  test('takes the newest observed reading even when an older one was confirmed later', async () => {
    const history = await parseHistory(
      historyBody([
        account('fake-a', [
          observation(NOW - 6 * HOUR_MS, 0.3, RESET, NOW - 5 * MINUTE_MS),
          observation(NOW - 3 * HOUR_MS, 0.35, RESET, NOW - 2 * HOUR_MS),
        ]),
      ])
    );

    expect(recordedLevelAt(recordedPool(history, [member('fake-a')], NOW - DAY_MS, NOW), NOW)).toBe(
      65
    );
  });

  test('refills a login at its reset and holds it full until the next reading', async () => {
    const history = await parseHistory(
      historyBody([
        account('fake-a', [
          observation(NOW - 10 * HOUR_MS, 0.9, NOW - 4 * HOUR_MS),
          observation(NOW - HOUR_MS, 0.05, NOW + 7 * DAY_MS - 4 * HOUR_MS),
        ]),
      ])
    );

    expect(
      recordedPool(history, [member('fake-a')], NOW - DAY_MS, NOW).map((segment) => segment.points)
    ).toEqual([
      [
        { atMs: NOW - 10 * HOUR_MS, poolPercent: 10 },
        { atMs: NOW - 4 * HOUR_MS, poolPercent: 10 },
        { atMs: NOW - 4 * HOUR_MS, poolPercent: 100 },
        { atMs: NOW - HOUR_MS, poolPercent: 100 },
        { atMs: NOW - HOUR_MS, poolPercent: 95 },
        { atMs: NOW, poolPercent: 95 },
      ],
    ]);
  });

  test('breaks the path at a gap, reads the gap as unknown, and ends at the response time', async () => {
    const history = await parseHistory(
      historyBody(
        [
          account('fake-a', [observation(NOW - 10 * HOUR_MS, 0.2, RESET)], {
            gaps: [[NOW - 8 * HOUR_MS, NOW - 6 * HOUR_MS]],
          }),
        ],
        { toMs: NOW - HOUR_MS }
      )
    );
    const segments = recordedPool(history, [member('fake-a')], NOW - DAY_MS, NOW);

    expect(segments.map((segment) => segment.points)).toEqual([
      [
        { atMs: NOW - 10 * HOUR_MS, poolPercent: 80 },
        { atMs: NOW - 8 * HOUR_MS, poolPercent: 80 },
      ],
      [
        { atMs: NOW - 6 * HOUR_MS, poolPercent: 80 },
        { atMs: NOW - HOUR_MS, poolPercent: 80 },
      ],
    ]);
    expect(recordedLevelAt(segments, NOW - 9 * HOUR_MS)).toBe(80);
    expect(recordedLevelAt(segments, NOW - 8 * HOUR_MS)).toBeNull();
    expect(recordedLevelAt(segments, NOW - 7 * HOUR_MS)).toBeNull();
    expect(recordedLevelAt(segments, NOW - 6 * HOUR_MS)).toBe(80);
    expect(recordedLevelAt(segments, NOW - 11 * HOUR_MS)).toBeNull();
    expect(recordedLevelAt(segments, NOW - 30 * MINUTE_MS)).toBeNull();
  });

  test('draws no total while a pool login has no history', async () => {
    const history = await parseHistory(
      historyBody([account('fake-a', [observation(NOW - 10 * HOUR_MS, 0.2, RESET)])])
    );

    expect(recordedPool(history, [member('fake-a'), member('fake-z')], NOW - DAY_MS, NOW)).toEqual(
      []
    );
    expect(recordedPool(history, [member('fake-a'), member(null)], NOW - DAY_MS, NOW)).toEqual([]);
  });

  test('applies a reset at the last recorded instant', async () => {
    const history = await parseHistory(
      historyBody([account('fake-a', [observation(NOW - HOUR_MS, 0.9, NOW)])])
    );

    const segments = recordedPool(history, [member('fake-a')], NOW - DAY_MS, NOW);
    expect(recordedLevelAt(segments, NOW - 1)).toBe(10);
    expect(recordedLevelAt(segments, NOW)).toBe(100);
  });
});

describe('burnOverWindow', () => {
  const pool = [member('fake-a'), member('fake-b')];
  const usage = (toMs = NOW) =>
    parseHistory(
      historyBody(
        [
          account('fake-a', [
            observation(NOW - 7 * HOUR_MS, 0.1, RESET),
            observation(NOW - 5 * HOUR_MS, 0.13, RESET),
            observation(NOW - 2 * HOUR_MS, 0.19, RESET),
            observation(NOW - 30 * MINUTE_MS, 0.25, RESET),
          ]),
          account('fake-b', [observation(NOW - 8 * HOUR_MS, 0.5, RESET)]),
        ],
        { toMs }
      )
    );

  test('measures used now minus used at the window start over each of 1h, 3h, and 6h', async () => {
    const history = await usage();
    expect(burnOverWindow(history, pool, NOW, 1)).toBeCloseTo(6);
    expect(burnOverWindow(history, pool, NOW, 3)).toBeCloseTo(4);
    expect(burnOverWindow(history, pool, NOW, 6)).toBeCloseTo(2.5);
  });

  test('measures from a reset inside the window, once 30 minutes have passed since it', async () => {
    const history = await parseHistory(
      historyBody([
        account('fake-a', [
          observation(NOW - 5 * HOUR_MS, 0.9, NOW - 2 * HOUR_MS),
          observation(NOW - HOUR_MS, 0.04, NOW + 7 * DAY_MS),
        ]),
      ])
    );
    expect(burnOverWindow(history, [member('fake-a')], NOW, 3)).toBeCloseTo(2);
    expect(burnOverWindow(history, [member('fake-a')], NOW - 100 * MINUTE_MS, 3)).toBeNull();
  });

  test('is unknown when a gap overlaps the window or a member has no reading at its start', async () => {
    const history = await parseHistory(
      historyBody([
        account('fake-a', [observation(NOW - 4 * HOUR_MS, 0.1, RESET)], {
          gaps: [[NOW - 2 * HOUR_MS, NOW - 90 * MINUTE_MS]],
        }),
        account('fake-b', [observation(NOW - 2 * HOUR_MS, 0.1, RESET)]),
      ])
    );
    expect(burnOverWindow(history, [member('fake-a')], NOW, 1)).toBe(0);
    expect(burnOverWindow(history, [member('fake-a')], NOW, 3)).toBeNull();
    expect(burnOverWindow(history, [member('fake-b')], NOW, 3)).toBeNull();
    expect(burnOverWindow(history, [member('fake-a'), member('fake-z')], NOW, 1)).toBeNull();
    expect(burnOverWindow(history, [member('fake-a'), member(null)], NOW, 1)).toBeNull();
    expect(burnOverWindow(null, [member('fake-a')], NOW, 1)).toBeNull();
  });

  test('is unknown once the history ends more than 30 minutes before now', async () => {
    const history = await usage(NOW - 40 * MINUTE_MS);
    expect(burnOverWindow(history, pool, NOW, 3)).toBeNull();
    expect(burnOverWindow(history, pool, NOW - 15 * MINUTE_MS, 3)).not.toBeNull();
  });

  test('the drain series samples the window burn every 30 minutes and at now', async () => {
    const series = drainSeries(await usage(), pool, NOW - 9 * HOUR_MS, NOW - 10 * MINUTE_MS, 1);
    expect(series.length).toBe(19);
    expect(series[0]).toEqual({ atMs: NOW - 9 * HOUR_MS, percentPerHour: null });
    expect(series[series.length - 1]).toEqual({
      atMs: NOW - 10 * MINUTE_MS,
      percentPerHour: expect.closeTo(6),
    });
  });
});
