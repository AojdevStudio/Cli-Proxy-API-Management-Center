import { describe, expect, spyOn, test } from 'bun:test';
import { apiCallApi } from '@/services/api/apiCall';
import { interpretReaderResponse, READER_URL, stripEmails, usageApi } from '@/services/api/usage';
import { readerFixture } from './fixtures/usagePanel';

const ready = (body: unknown) => ({ statusCode: 200, body, header: {}, bodyText: '' });

describe('usage reader client', () => {
  test('parses every committed reader fixture as ready', async () => {
    const cases = [
      ['health.json', () => usageApi.health()],
      ['overview-today.json', () => usageApi.overview('today')],
      ['overview-7d.json', () => usageApi.overview('7d')],
      ['sessions-today.json', () => usageApi.sessions('today')],
      ['session-turns.json', () => usageApi.session('60b63e47-x')],
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
      await usageApi.session('a/b');
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
      interpretReaderResponse({ statusCode: 503, body: { state: 'warming', rowsLoaded: 1200 } }, parse)
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

  test('a management API error on the relay call becomes a typed state', async () => {
    const request = spyOn(apiCallApi, 'request').mockRejectedValue(
      Object.assign(new Error('Bad Gateway'), { status: 502 })
    );
    try {
      expect(await usageApi.health()).toEqual({ status: 'offline', reason: { kind: 'reader-down' } });
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
