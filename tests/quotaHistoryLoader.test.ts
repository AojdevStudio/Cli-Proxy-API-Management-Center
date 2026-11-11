import { beforeEach, describe, expect, test } from 'bun:test';
import type { QuotaHistory } from '@/features/quota/history';
import { createQuotaHistoryLoader } from '@/features/quota/hooks/useQuotaHistory';
import type { UsageResult } from '@/features/usage/types';
import type { QuotaHistoryQuery } from '@/services/api/quotaHistoryContract';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { NOW } from './fixtures/quotaHistory';

type Result = UsageResult<QuotaHistory>;

const ready = (provider: 'claude' | 'codex'): Result => ({
  status: 'ready',
  data: { provider, range: '7d', fromMs: 0, toMs: NOW, logins: new Map() },
});

function heldReader() {
  const pending: { query: Required<QuotaHistoryQuery>; answer: (result: Result) => void }[] = [];
  const fetch = (query: Required<QuotaHistoryQuery>) =>
    new Promise<Result>((answer) => pending.push({ query, answer }));
  return { pending, fetch };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('quota history loader', () => {
  beforeEach(() => {
    useQuotaStore.getState().clearQuotaCache();
  });

  test('asks for every ledger provider and commits each answer under its connection', async () => {
    const reader = heldReader();
    const commits: [number, string, Result][] = [];
    const loader = createQuotaHistoryLoader({
      fetch: reader.fetch,
      commit: (generation, provider, result) => commits.push([generation, provider, result]),
    });
    const generation = useQuotaStore.getState().cacheGeneration;

    loader.load(NOW);
    expect(reader.pending.map(({ query }) => query.provider)).toEqual(['claude', 'codex']);
    reader.pending[1].answer(ready('codex'));
    await settle();

    expect(commits).toEqual([[generation, 'codex', ready('codex')]]);
  });

  test('drops an answer that lands after the connection changed', async () => {
    const reader = heldReader();
    const commits: unknown[] = [];
    const loader = createQuotaHistoryLoader({
      fetch: reader.fetch,
      commit: (...args) => commits.push(args),
    });

    loader.load(NOW);
    useQuotaStore.getState().clearQuotaCache();
    reader.pending.forEach(({ query }, index) =>
      reader.pending[index].answer(ready(query.provider))
    );
    await settle();

    expect(commits).toEqual([]);
  });

  test('drops an answer from a load that a newer load or a stop replaced', async () => {
    const reader = heldReader();
    const commits: string[] = [];
    const loader = createQuotaHistoryLoader({
      fetch: reader.fetch,
      commit: (_generation, provider) => commits.push(provider),
    });

    loader.load(NOW);
    loader.load(NOW);
    reader.pending[0].answer(ready('claude'));
    reader.pending[2].answer(ready('claude'));
    await settle();
    loader.stop();
    reader.pending[3].answer(ready('codex'));
    await settle();

    expect(commits).toEqual(['claude']);
  });

  test('retries a warming reader once, then keeps its answer', async () => {
    const asked: string[] = [];
    const commits: string[] = [];
    const loader = createQuotaHistoryLoader({
      fetch: async ({ provider }) => {
        asked.push(provider);
        return { status: 'warming', rowsLoaded: 10 };
      },
      commit: (_generation, provider, result) => commits.push(`${provider}:${result.status}`),
      warmingRetryMs: 0,
    });

    loader.load(NOW);
    await settle();
    await settle();
    await settle();

    expect(asked.sort()).toEqual(['claude', 'claude', 'codex', 'codex']);
    expect(commits.sort()).toEqual([
      'claude:warming',
      'claude:warming',
      'codex:warming',
      'codex:warming',
    ]);
  });
});
