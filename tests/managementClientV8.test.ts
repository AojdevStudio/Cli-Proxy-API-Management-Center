import { afterEach, describe, expect, test } from 'bun:test';
import type { AxiosAdapter } from 'axios';
import { apiClient } from '../src/services/api/client';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  apiClient.setConfig({ apiBase: '', managementKey: '' });
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('v8 management transport', () => {
  test('uses the v8 prefix, bearer authentication and bare JSON scalar writes', async () => {
    apiClient.setConfig({
      apiBase: 'https://proxy.invalid/gateway/v8/management',
      managementKey: 'fixture-only',
    });
    const adapter: AxiosAdapter = async (config) => {
      expect(config.baseURL).toBe('https://proxy.invalid/gateway/v8/management');
      expect(config.url).toBe('/config/observability/logs/debug');
      expect(config.headers.Authorization).toBe('Bearer fixture-only');
      expect(config.data).toBe('false');
      return { data: { status: 'ok' }, status: 200, statusText: 'OK', headers: {}, config };
    };
    await apiClient.put('/config/observability/logs/debug', false, { adapter });
  });

  test('retains backend version and plugin support events', async () => {
    const events: Event[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        dispatchEvent: (event: Event) => {
          events.push(event);
          return true;
        },
      },
    });
    apiClient.setConfig({ apiBase: 'http://proxy.invalid', managementKey: 'fixture-only' });
    const adapter: AxiosAdapter = async (config) => ({
      data: {},
      status: 200,
      statusText: 'OK',
      config,
      headers: { 'x-cpa-version': 'v8.0.3', 'x-cpa-support-plugin': 'true' },
    });
    await apiClient.get('/config', { adapter });
    expect(events.map((event) => event.type)).toEqual([
      'server-version-update',
      'server-plugin-support-update',
    ]);
    expect((events[0] as CustomEvent).detail.version).toBe('v8.0.3');
    expect((events[1] as CustomEvent).detail.supportsPlugin).toBe(true);
  });

  const connectionA = { apiBase: 'https://a.invalid', managementKey: 'key-a' };
  test.each([
    [
      'an endpoint change',
      () => apiClient.setConfig({ ...connectionA, apiBase: 'https://b.invalid' }),
    ],
    [
      'a key change on the same endpoint',
      () => apiClient.setConfig({ ...connectionA, managementKey: 'key-b' }),
    ],
    [
      'a switch away and back',
      () => {
        apiClient.setConfig({ apiBase: 'https://b.invalid', managementKey: 'key-b' });
        apiClient.setConfig(connectionA);
      },
    ],
  ])('drops session events from requests answered after %s', async (_, switchConnection) => {
    const events: string[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { dispatchEvent: (event: Event) => events.push(event.type) },
    });
    const versioned: AxiosAdapter = async (config) => ({
      data: {},
      status: 200,
      statusText: 'OK',
      config,
      headers: { 'x-cpa-version': 'v8.0.3', 'x-cpa-support-plugin': 'true' },
    });
    const unauthorized: AxiosAdapter = async (config) => {
      throw { isAxiosError: true, message: 'Unauthorized', config, response: { status: 401 } };
    };
    const holdUntilReleased = (adapter: AxiosAdapter) => {
      let markSent = () => {};
      let release = () => {};
      const sent = new Promise<void>((resolve) => (markSent = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      const held: AxiosAdapter = async (config) => {
        markSent();
        await released;
        return adapter(config);
      };
      return { held, sent, release };
    };

    apiClient.setConfig(connectionA);
    const success = holdUntilReleased(versioned);
    const failure = holdUntilReleased(unauthorized);
    const read = apiClient.get('/config', { adapter: success.held });
    const write = apiClient.put('/config/observability/logs/debug', true, {
      adapter: failure.held,
    });
    await Promise.all([success.sent, failure.sent]);
    switchConnection();
    success.release();
    failure.release();
    expect(await read).toEqual({});
    await expect(write).rejects.toMatchObject({ name: 'ApiError', status: 401 });
    expect(events).toEqual([]);

    await apiClient.get('/config', { adapter: versioned });
    await expect(apiClient.get('/config', { adapter: unauthorized })).rejects.toMatchObject({
      status: 401,
    });
    expect(events).toEqual([
      'server-version-update',
      'server-plugin-support-update',
      'unauthorized',
    ]);
  });
});

test('captured SIWC transport keeps original credentials and suppresses stale events, including ABA', async () => {
  const events: Event[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dispatchEvent: (event: Event) => {
        events.push(event);
        return true;
      },
    },
  });
  apiClient.setConfig({ apiBase: 'https://original.invalid', managementKey: 'original-fixture' });
  const captured = apiClient.captureConnection();
  apiClient.setConfig({ apiBase: 'https://new.invalid', managementKey: 'new-fixture' });
  const adapter: AxiosAdapter = async (config) => {
    expect(config.baseURL).toBe('https://original.invalid/v8/management');
    expect(config.headers.Authorization).toBe('Bearer original-fixture');
    return {
      data: {},
      status: 200,
      statusText: 'OK',
      config,
      headers: { 'x-cpa-version': 'old', 'x-cpa-support-plugin': 'true' },
    };
  };
  await captured.delete('/oauth/session', { params: { state: 'original-session' }, adapter });
  apiClient.setConfig({ apiBase: 'https://original.invalid', managementKey: 'original-fixture' });
  await captured.delete('/oauth/session', { params: { state: 'original-session' }, adapter });
  expect(events).toEqual([]);
  const unauthorized: AxiosAdapter = async (config) => {
    throw { isAxiosError: true, message: 'Unauthorized', config, response: { status: 401 } };
  };
  await expect(captured.delete('/oauth/session', { adapter: unauthorized })).rejects.toThrow();
  expect(events).toEqual([]);
});
