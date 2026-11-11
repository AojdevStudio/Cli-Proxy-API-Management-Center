import { describe, expect, test } from 'bun:test';
import { historyRangeFor, poolBurn, recordedLevelAt, recordedPool } from '@/features/quota/history';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import {
  NOW,
  NO_BURN,
  account,
  historyBody,
  measured,
  observation,
  parseHistory,
} from './fixtures/quotaHistory';

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

    expect(segments).toEqual([
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

    expect(recordedPool(history, [member('fake-a')], NOW - 2 * DAY_MS, NOW)).toEqual([
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

    expect(recordedPool(history, [member('fake-a')], NOW - DAY_MS, NOW)).toEqual([
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

    expect(segments).toEqual([
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
    expect(recordedLevelAt(segments, NOW - 7 * HOUR_MS)).toBeNull();
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
});

describe('poolBurn', () => {
  const burnHistory = (aBurnTo = NOW - 10 * MINUTE_MS, aResetAt = RESET) =>
    parseHistory(
      historyBody([
        account('fake-a', [observation(NOW - 2 * HOUR_MS, 0.4, aResetAt)], {
          burn: measured(1.5, aBurnTo),
        }),
        account('fake-b', [observation(NOW - HOUR_MS, 0.1, RESET)], {
          burn: measured(2.25, NOW - 5 * MINUTE_MS),
        }),
        account('fake-c', [observation(NOW - HOUR_MS, 0.1, RESET)], { burn: NO_BURN }),
      ])
    );

  test('sums the measured rates of every pool login', async () => {
    expect(poolBurn(await burnHistory(), [member('fake-b'), member('fake-a')], NOW)).toBe(3.75);
  });

  test('is unknown when any pool login is insufficient or missing', async () => {
    const history = await burnHistory();
    expect(poolBurn(history, [member('fake-a'), member('fake-c')], NOW)).toBeNull();
    expect(poolBurn(history, [member('fake-a'), member('fake-z')], NOW)).toBeNull();
    expect(poolBurn(history, [member('fake-a'), member(null)], NOW)).toBeNull();
    expect(poolBurn(null, [member('fake-a')], NOW)).toBeNull();
    expect(poolBurn(history, [], NOW)).toBeNull();
  });

  test('stops trusting a cached rate 30 minutes after its last confirmation', async () => {
    const history = await burnHistory();
    expect(poolBurn(history, [member('fake-a')], NOW + 20 * MINUTE_MS)).toBe(1.5);
    expect(poolBurn(history, [member('fake-a')], NOW + 25 * MINUTE_MS)).toBeNull();
  });

  test('stops trusting a cached rate once the login has reset', async () => {
    const history = await burnHistory(NOW, NOW + 10 * MINUTE_MS);
    expect(poolBurn(history, [member('fake-a')], NOW + 5 * MINUTE_MS)).toBe(1.5);
    expect(poolBurn(history, [member('fake-a')], NOW + 10 * MINUTE_MS)).toBeNull();
  });
});

describe('historyRangeFor', () => {
  test('asks for the smallest range that covers the chart from its start to now', () => {
    expect(historyRangeFor(NOW - 20 * HOUR_MS, NOW)).toBe('24h');
    expect(historyRangeFor(NOW - 7 * DAY_MS, NOW)).toBe('7d');
    expect(historyRangeFor(NOW - 7 * DAY_MS - HOUR_MS, NOW)).toBe('14d');
  });
});
