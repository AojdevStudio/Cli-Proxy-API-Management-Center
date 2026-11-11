import { describe, expect, spyOn, test } from 'bun:test';
import { apiCallApi } from '@/services/api/apiCall';
import { interpretReaderResponse, READER_URL, stripEmails, usageApi } from '@/services/api/usage';
import { parsed, readerFixture } from './fixtures/usagePanel';
import {
  NOW,
  account,
  historyBody,
  measured,
  observation,
  parseHistory,
} from './fixtures/quotaHistory';

const ready = (body: unknown) => ({ statusCode: 200, body, header: {}, bodyText: '' });

describe('usage reader client', () => {
  test('parses every committed reader fixture as ready', async () => {
    const cases = [
      ['health.json', () => usageApi.health()],
      ['overview-today.json', () => usageApi.overview('today')],
      ['overview-7d.json', () => usageApi.overview('7d')],
      ['sessions-today.json', () => usageApi.sessions('today')],
      ['session-turns.json', () => usageApi.sessionTurns('claude-code:aaaaaaaa')],
      ['quota-history.json', () => usageApi.quotaHistory({ provider: 'codex', range: '7d' })],
    ] as const;
    for (const [name, call] of cases) {
      const request = spyOn(apiCallApi, 'request').mockResolvedValue(ready(readerFixture(name)));
      try {
        const result = await call();
        expect({ name, status: result.status }).toEqual({ name, status: 'ready' });
      } finally {
        request.mockRestore();
      }
    }
  });

  test('sends plain GETs at the reader loopback through the relay', async () => {
    const request = spyOn(apiCallApi, 'request').mockResolvedValue(
      ready(readerFixture('overview-today.json'))
    );
    try {
      await usageApi.overview('today');
      await usageApi.sessionTurns('a/b');
      expect(request.mock.calls.map(([payload]) => payload)).toEqual([
        { method: 'GET', url: `${READER_URL}/v1/overview?range=today&groupBy=provider` },
        { method: 'GET', url: `${READER_URL}/v1/sessions/a%2Fb` },
      ]);
    } finally {
      request.mockRestore();
    }
  });

  test('maps relay outcomes to reader states', () => {
    const parse = () => 'parsed';
    expect(interpretReaderResponse({ statusCode: 0, body: null }, parse)).toEqual({
      status: 'offline',
      reason: { kind: 'reader-down' },
    });
    expect(interpretReaderResponse({ statusCode: 502, body: 'bad gateway' }, parse)).toEqual({
      status: 'offline',
      reason: { kind: 'reader-down' },
    });
    expect(
      interpretReaderResponse(
        { statusCode: 503, body: { state: 'warming', rowsLoaded: 1200 } },
        parse
      )
    ).toEqual({ status: 'warming', rowsLoaded: 1200 });
    expect(interpretReaderResponse({ statusCode: 403, body: null }, parse)).toEqual({
      status: 'offline',
      reason: { kind: 'relay-refused', status: 403 },
    });
    expect(interpretReaderResponse({ statusCode: 200, body: { contract: 2 } }, parse)).toEqual({
      status: 'offline',
      reason: { kind: 'contract-mismatch', got: 2 },
    });
    expect(interpretReaderResponse({ statusCode: 200, body: { contract: 1 } }, parse)).toEqual({
      status: 'ready',
      data: 'parsed',
    });
    expect(interpretReaderResponse({ statusCode: 503, body: { state: 'warming' } }, parse)).toEqual(
      {
        status: 'offline',
        reason: { kind: 'bad-response', detail: 'rowsLoaded: expected number' },
      }
    );
  });

  test('reads the reader totals, bucket totals, sessions, and heartbeat as sent', async () => {
    const today = await parsed('overview-today.json', () => usageApi.overview('today'));
    expect(today.totals.tokens).toBe(236140);
    expect(today.series.bucketTokens).toHaveLength(today.series.buckets.length);
    expect(today.series.bucketTokens.reduce((a, b) => a + b, 0)).toBe(today.totals.tokens);

    const list = await parsed('sessions-today.json', () => usageApi.sessions('today'));
    expect(list.sessionCount).toBe(3);
    expect(list.sessions[0]).toMatchObject({
      id: 'claude-code:aaaaaaaa-0000-4000-8000-000000000001',
      sessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
      client: 'claude-code',
    });

    const health = await parsed('health.json', () => usageApi.health());
    expect(health.collectorHeartbeatAt).toBe(Date.parse('2026-11-05T21:29:30.000Z'));
  });

  test('a session wire id reaches the reader encoded as one path segment', async () => {
    const request = spyOn(apiCallApi, 'request').mockResolvedValue(
      ready(readerFixture('session-turns.json'))
    );
    try {
      await usageApi.sessionTurns('claude-code:aaaaaaaa-0000-4000-8000-000000000001');
      expect(request.mock.calls[0][0].url).toBe(
        `${READER_URL}/v1/sessions/claude-code%3Aaaaaaaaa-0000-4000-8000-000000000001`
      );
    } finally {
      request.mockRestore();
    }
  });

  test('bucket totals that do not line up with the buckets are a bad response', async () => {
    const body = structuredClone(readerFixture('overview-today.json')) as {
      series: { bucketTotals: unknown[] };
    };
    body.series.bucketTotals.pop();
    const request = spyOn(apiCallApi, 'request').mockResolvedValue(ready(body));
    try {
      expect(await usageApi.overview('today')).toEqual({
        status: 'offline',
        reason: { kind: 'bad-response', detail: 'series.bucketTotals: expected 24 values' },
      });
    } finally {
      request.mockRestore();
    }
  });

  test('an empty ledger and a missing heartbeat still parse', async () => {
    const overview = structuredClone(readerFixture('overview-7d.json')) as {
      coverage: Record<string, unknown>;
    };
    overview.coverage.oldestAt = null;
    overview.coverage.newestAt = null;
    overview.coverage.rangeFullyCovered = false;
    const health = structuredClone(readerFixture('health.json')) as {
      collector: Record<string, unknown>;
    };
    health.collector = { heartbeatAt: null, ageSeconds: null, stale: true };
    const request = spyOn(apiCallApi, 'request')
      .mockResolvedValueOnce(ready(overview))
      .mockResolvedValueOnce(ready(health));
    try {
      const week = await usageApi.overview('7d');
      expect(week.status === 'ready' && week.data.coverage.oldestAt).toBeNull();
      const beat = await usageApi.health();
      expect(beat.status === 'ready' && beat.data.collectorHeartbeatAt).toBeNull();
    } finally {
      request.mockRestore();
    }
  });

  test('a reader that cannot sync its logs says why', () => {
    expect(
      interpretReaderResponse(
        {
          statusCode: 503,
          body: { contract: 1, state: 'unavailable', reason: 'EACCES: usage dir' },
        },
        () => 'parsed'
      )
    ).toEqual({
      status: 'offline',
      reason: { kind: 'reader-failed', detail: 'EACCES: usage dir' },
    });
  });

  test('an error the reader itself sent is not blamed on the relay', () => {
    const parse = () => 'parsed';
    expect(
      interpretReaderResponse(
        { statusCode: 500, body: { contract: 1, error: 'privacy_guard' } },
        parse
      )
    ).toEqual({
      status: 'offline',
      reason: { kind: 'reader-error', status: 500, error: 'privacy_guard' },
    });
    expect(
      interpretReaderResponse({ statusCode: 404, body: { contract: 1, error: 'not_found' } }, parse)
    ).toEqual({
      status: 'offline',
      reason: { kind: 'reader-error', status: 404, error: 'not_found' },
    });
  });

  test('a body missing a contract field is a bad response naming the path', async () => {
    const body = structuredClone(readerFixture('overview-today.json')) as {
      totals: Record<string, unknown>;
    };
    delete body.totals.cacheWrite;
    const request = spyOn(apiCallApi, 'request').mockResolvedValue(ready(body));
    try {
      expect(await usageApi.overview('today')).toEqual({
        status: 'offline',
        reason: { kind: 'bad-response', detail: 'totals.cacheWrite: expected number' },
      });
    } finally {
      request.mockRestore();
    }
  });

  test('a timestamp that is not a time is a bad response, not an Invalid Date', async () => {
    const body = structuredClone(readerFixture('overview-today.json')) as { to: string };
    body.to = 'soon';
    const request = spyOn(apiCallApi, 'request').mockResolvedValue(ready(body));
    try {
      expect(await usageApi.overview('today')).toEqual({
        status: 'offline',
        reason: { kind: 'bad-response', detail: 'to: expected ISO 8601 time' },
      });
    } finally {
      request.mockRestore();
    }
  });

  test('a change to a field the page never shows does not take it offline', async () => {
    const body = structuredClone(readerFixture('overview-today.json')) as Record<string, unknown>;
    body.cost = { billed: 'changed units' };
    const request = spyOn(apiCallApi, 'request').mockResolvedValue(ready(body));
    try {
      expect((await usageApi.overview('today')).status).toBe('ready');
    } finally {
      request.mockRestore();
    }
  });

  test('a management API error on the relay call becomes a typed state', async () => {
    const request = spyOn(apiCallApi, 'request').mockRejectedValue(
      Object.assign(new Error('Bad Gateway'), { status: 502 })
    );
    try {
      expect(await usageApi.health()).toEqual({
        status: 'offline',
        reason: { kind: 'reader-down' },
      });
    } finally {
      request.mockRestore();
    }
  });

  test('labels lose emails at the edge', async () => {
    const body = structuredClone(readerFixture('overview-today.json')) as {
      breakdown: { account: { label: string }[] };
    };
    body.breakdown.account[0].label = 'claude ossie@example.com';
    const request = spyOn(apiCallApi, 'request').mockResolvedValue(ready(body));
    try {
      const result = await usageApi.overview('today');
      expect(result.status === 'ready' && result.data.breakdown.account[0].label).toBe('claude');
    } finally {
      request.mockRestore();
    }
    expect(stripEmails('a@b.c x @ y')).toBe('x y');
  });
});

describe('quota history', () => {
  const RESET = NOW + 3 * 86_400_000;
  const HOUR = 3_600_000;
  const body = () =>
    historyBody(
      [
        account(
          'fake-a',
          [observation(NOW - 30 * HOUR, 0.25, RESET), observation(NOW - 2 * HOUR, 0.42, RESET)],
          { gaps: [[NOW - 8 * HOUR, NOW - 6 * HOUR]], burn: measured(1.5, NOW - 600_000) }
        ),
        account('fake-b', [], { burn: { state: 'insufficient', reason: 'no_observations' } }),
      ],
      { provider: 'codex' }
    );

  test('asks the reader for one provider and range through the relay', async () => {
    const request = spyOn(apiCallApi, 'request').mockResolvedValue(ready(body()));
    try {
      await usageApi.quotaHistory({ provider: 'codex', range: '7d' });
      expect(request.mock.calls[0][0]).toEqual({
        method: 'GET',
        url: `${READER_URL}/v1/quota-history?provider=codex&range=7d`,
      });
    } finally {
      request.mockRestore();
    }
  });

  test('reads times as epoch ms and utilization as percent, keyed by auth index', async () => {
    const history = await parseHistory(body());
    expect(history.fromMs).toBe(NOW - 7 * 24 * HOUR);
    expect(history.toMs).toBe(NOW);
    expect([...history.logins.keys()]).toEqual(['fake-a', 'fake-b']);
    expect(history.logins.get('fake-a')).toEqual({
      readings: [
        { observedAtMs: NOW - 30 * HOUR, usedPercent: 25, resetAtMs: RESET },
        { observedAtMs: NOW - 2 * HOUR, usedPercent: 42, resetAtMs: RESET },
      ],
      gaps: [{ fromMs: NOW - 8 * HOUR, toMs: NOW - 6 * HOUR }],
      burn: { state: 'measured', percentPerHour: 1.5, toMs: NOW - 600_000 },
    });
    expect(history.logins.get('fake-b')?.burn).toEqual({
      state: 'insufficient',
      reason: 'no_observations',
    });
  });

  test('a body that breaks the contract is a bad response naming the field', async () => {
    const broken: [string, (wire: ReturnType<typeof body>) => void][] = [
      ['provider', (wire) => (wire.provider = 'claude')],
      ['range', (wire) => (wire.range = '14d')],
      ['window', (wire) => Object.assign(wire, { window: 'five_hour' })],
      [
        'accounts[0].observations[1].utilization',
        (wire) => (wire.accounts[0].observations[1].utilization = 1.2),
      ],
      ['accounts[0].observations[1]', (wire) => wire.accounts[0].observations.reverse()],
      [
        'accounts[0].observations[0].observedAt',
        (wire) => Object.assign(wire.accounts[0].observations[0], { observedAt: null }),
      ],
      [
        'accounts[1].burn.reason',
        (wire) =>
          Object.assign(wire.accounts[1], {
            burn: { state: 'insufficient', reason: 'utilization_fell' },
          }),
      ],
      [
        'accounts[0].burn.percentPerHour',
        (wire) => Object.assign(wire.accounts[0].burn, { percentPerHour: -1 }),
      ],
      ['accounts[1].authIndex', (wire) => (wire.accounts[1].authIndex = 'fake-a')],
      ['accounts[0].observations', (wire) => (wire.accounts[0].observations = [])],
      [
        'accounts[0].gaps[0].to',
        (wire) => {
          const [gap] = wire.accounts[0].gaps;
          [gap.from, gap.to] = [gap.to, gap.from];
        },
      ],
    ];
    for (const [field, breakIt] of broken) {
      const wire = body();
      breakIt(wire);
      const request = spyOn(apiCallApi, 'request').mockResolvedValue(ready(wire));
      try {
        const result = await usageApi.quotaHistory({ provider: 'codex', range: '7d' });
        const reason = result.status === 'offline' ? result.reason : null;
        expect({ field, kind: reason?.kind }).toEqual({ field, kind: 'bad-response' });
        expect(reason?.kind === 'bad-response' && reason.detail).toStartWith(`${field}: `);
      } finally {
        request.mockRestore();
      }
    }
  });

  test('coverage run times may be null', async () => {
    const wire = body();
    wire.coverage.oldestRunAt = null;
    wire.coverage.newestRunAt = null;
    expect((await parseHistory(wire)).logins.size).toBe(2);
  });
});
