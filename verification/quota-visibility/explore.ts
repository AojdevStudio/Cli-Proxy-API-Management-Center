import { createElement } from 'react';
import process from 'node:process';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { LedgerPanel } from '@/features/quota/ledger/LedgerPanel';
import { ledgerPool, type LedgerEntry } from '@/features/quota/ledger/ledgerModel';
import { CLAUDE_CONFIG, type ClaudeQuotaData } from '@/features/quota/providers/claude/data';
import { restoreQuotaCache, startQuotaPersistence } from '@/features/quota/quotaPersistence';
import { useAuthStore } from '@/stores/useAuthStore';
import { markQuotaSettled, useQuotaStore } from '@/stores/useQuotaStore';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const BASE = 'https://quota-verification.invalid';
const CACHE_KEY = 'quotaCache.v1';
const credentials = ['claude-proof-a.json', 'claude-proof-b.json'] as const;
type Credential = (typeof credentials)[number];
type Observation = Pick<ClaudeQuotaData, 'windows' | 'observedAt'>;
type Known = Partial<Record<Credential, Observation>>;
type Event =
  | { kind: 'start'; credential: Credential }
  | { kind: '429'; credential: Credential }
  | { kind: 'success'; credential: Credential; sample: number }
  | { kind: 'save' }
  | { kind: 'reload' };
type Scenario = { credentials: number; rememberPassword: boolean; depth: number };
type Witness = { events: string[]; credential: Credential; expected: string; actual: string };
type Property = { id: string; claim: string; counterexample: Witness | null };

const samples: Observation[] = [50, 100, 0].map((usedPercent, sample) => ({
  observedAt: new Date(NOW + sample * 1000).toISOString(),
  windows: ['seven-day', 'seven-day-fable'].map((id) => ({
    id,
    label: id,
    usedPercent: id === 'seven-day-fable' && sample === 0 ? 95 : usedPercent,
    resetLabel: '3d',
    resetAtMs: NOW + 3 * 24 * 60 * 60 * 1000,
    periodHours: 168,
  })),
}));

const scenarios: Scenario[] = [
  { credentials: 1, rememberPassword: true, depth: 6 },
  { credentials: 2, rememberPassword: true, depth: 5 },
  { credentials: 1, rememberPassword: false, depth: 5 },
];

const storage = new Map<string, string>();
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

const timeouts = new Map<number, () => void>();
let timerId = 0;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalNow = Date.now;
const initialQuota = useQuotaStore.getInitialState();

function installClock() {
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number) => {
    if (typeof handler !== 'function' || delay !== 1000) {
      throw new Error('The checker only models the quota persistence save timer');
    }
    const id = ++timerId;
    timeouts.set(id, () => handler());
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => timeouts.delete(id)) as typeof clearTimeout;
  Date.now = () => NOW;
}

function label(event: Event): string {
  if (event.kind === 'save') return 'The one-second save timer fires';
  if (event.kind === 'reload') return 'Reload the same browser and reopen the same backend';
  if (event.kind === 'start') return `Start quota refresh for ${event.credential}`;
  if (event.kind === '429') return `Quota refresh for ${event.credential} returns 429`;
  return `Quota refresh for ${event.credential} succeeds with sample ${event.sample}`;
}

function run(scenario: Scenario, events: Event[]) {
  storage.clear();
  timeouts.clear();
  timerId = 0;
  useQuotaStore.setState(initialQuota, true);
  useAuthStore.setState({
    isAuthenticated: true,
    apiBase: BASE,
    rememberPassword: scenario.rememberPassword,
    connectionStatus: 'disconnected',
  });
  let stop = startQuotaPersistence();
  let received: Known = {};
  const everReceived: Known = {};
  let saved: Known = {};
  const pending = new Set<Credential>();
  const settled = new Set<Credential>();

  try {
    for (const event of events) {
      if (event.kind === 'save') {
        for (const [id, callback] of [...timeouts]) {
          timeouts.delete(id);
          callback();
        }
        if (scenario.rememberPassword) saved = { ...saved, ...received };
      } else if (event.kind === 'reload') {
        stop();
        useQuotaStore.setState(initialQuota, true);
        restoreQuotaCache(BASE);
        stop = startQuotaPersistence();
        pending.clear();
        settled.clear();
        received = {};
      } else if (event.kind === 'start') {
        pending.add(event.credential);
        useQuotaStore.getState().setClaudeQuota((previous) => ({
          ...previous,
          [event.credential]: CLAUDE_CONFIG.buildLoadingState(),
        }));
      } else if (event.kind === '429') {
        pending.delete(event.credential);
        settled.add(event.credential);
        useQuotaStore.getState().setClaudeQuota((previous) => ({
          ...previous,
          [event.credential]: CLAUDE_CONFIG.buildErrorState('Rate limited', 429),
        }));
        markQuotaSettled([event.credential]);
      } else {
        pending.delete(event.credential);
        settled.add(event.credential);
        const observation = samples[event.sample];
        received[event.credential] = observation;
        everReceived[event.credential] = observation;
        useQuotaStore.getState().setClaudeQuota((previous) => ({
          ...previous,
          [event.credential]: CLAUDE_CONFIG.buildSuccessState({
            ...observation,
            dollarWindows: [],
          }),
        }));
        markQuotaSettled([event.credential]);
      }
    }

    const store = useQuotaStore.getState();
    const quota = store.claudeQuota;
    const reloaded = events[events.length - 1]?.kind === 'reload';
    const ledgers: LedgerEntry[] = credentials.slice(0, scenario.credentials).map((name) => ({
      provider: 'claude',
      entry: { type: 'claude', file: { name, type: 'claude', authIndex: name } },
      quota: quota[name],
    }));
    const markup = renderToStaticMarkup(
      createElement(LedgerPanel, {
        provider: 'claude',
        ledgers,
        pool: ledgerPool(ledgers, 'seven-day', NOW),
        now: NOW,
        canUseActions: false,
        resettingQuotaName: null,
        onRefresh: () => {},
        onReset: () => {},
      })
    );
    const rows = [...markup.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((match) => match[1]);
    const rowFor = (name: Credential) => rows.find((row) => row.includes(name)) ?? '';
    const visible = (name: Credential) => rowFor(name).includes('% left');
    const same = (name: Credential, expected: Observation) =>
      visible(name) &&
      JSON.stringify(quota[name]?.windows) === JSON.stringify(expected.windows) &&
      quota[name]?.observedAt === expected.observedAt;
    const enabled: Event[] = [{ kind: 'reload' }];
    if (timeouts.size) enabled.push({ kind: 'save' });
    for (const name of credentials.slice(0, scenario.credentials)) {
      if (pending.has(name)) {
        enabled.push({ kind: '429', credential: name });
        samples.forEach((_, sample) => enabled.push({ kind: 'success', credential: name, sample }));
      } else enabled.push({ kind: 'start', credential: name });
    }
    return {
      key: JSON.stringify({
        store,
        reloaded,
        stored: storage.get(CACHE_KEY),
        timer: timeouts.size > 0,
        received,
        everReceived,
        saved,
        pending: [...pending].sort(),
        settled: [...settled].sort(),
      }),
      enabled,
      violations: credentials.slice(0, scenario.credentials).flatMap((name) => {
        const observation = received[name];
        const prior = everReceived[name];
        const durable = saved[name];
        const expected = observation ?? durable ?? prior;
        const actual = {
          status: quota[name]?.status ?? 'absent',
          windows: quota[name]?.windows ?? [],
          shownPercentages: [...rowFor(name).matchAll(/(\d+)% left/g)].map((match) =>
            Number(match[1])
          ),
        };
        const witness: Witness = {
          events: events.map(label),
          credential: name,
          expected: expected ? JSON.stringify(expected) : 'A reported quota percentage',
          actual: JSON.stringify(actual),
        };
        return [
          ...(settled.has(name) && !pending.has(name) && !visible(name)
            ? [['QUOTA_ALWAYS_VISIBLE', witness] as const]
            : []),
          ...(observation && !same(name, observation)
            ? [['KNOWN_VALUES_RETAINED', witness] as const]
            : []),
          ...(reloaded && prior && !visible(name)
            ? [['KNOWN_VALUES_SURVIVE_RELOAD', witness] as const]
            : []),
          ...(reloaded && durable && !same(name, durable)
            ? [['SAVED_VALUES_SURVIVE_RELOAD', witness] as const]
            : []),
          ...(!prior && visible(name)
            ? [
                [
                  'NO_INVENTED_QUOTA',
                  { ...witness, expected: 'No percentage without an observation' },
                ] as const,
              ]
            : []),
        ];
      }),
    };
  } finally {
    stop();
  }
}

export async function explore() {
  try {
    await i18n.changeLanguage('en');
    installClock();
    const results = scenarios.map((scenario) => {
      const properties: Property[] = [
        {
          id: 'QUOTA_ALWAYS_VISIBLE',
          claim: 'A settled quota read leaves a visible percentage.',
          counterexample: null,
        },
        {
          id: 'KNOWN_VALUES_RETAINED',
          claim: 'Refreshes preserve received values and their observation time.',
          counterexample: null,
        },
        {
          id: 'KNOWN_VALUES_SURVIVE_RELOAD',
          claim: 'A browser reload preserves a previously received quota.',
          counterexample: null,
        },
        {
          id: 'SAVED_VALUES_SURVIVE_RELOAD',
          claim: 'After a save timer, known values survive later saves and reloads.',
          counterexample: null,
        },
        {
          id: 'NO_INVENTED_QUOTA',
          claim: 'The Ledger shows no percentage before any observation exists.',
          counterexample: null,
        },
      ];
      const queue: Event[][] = [[]];
      const seen = new Map<string, string>();
      let transitions = 0;
      for (let index = 0; index < queue.length; index += 1) {
        const events = queue[index];
        const state = run(scenario, events);
        const signature = JSON.stringify([
          state.violations.map(([id]) => id),
          state.enabled.map(label),
        ]);
        const first = seen.get(state.key);
        if (first !== undefined) {
          if (first !== signature)
            throw new Error(`State key merges different behavior: ${state.key}`);
          continue;
        }
        seen.set(state.key, signature);
        for (const [id, witness] of state.violations) {
          const property = properties.find((candidate) => candidate.id === id)!;
          property.counterexample ??= witness;
        }
        if (events.length < scenario.depth) {
          for (const event of state.enabled) {
            queue.push([...events, event]);
            transitions += 1;
          }
        }
      }
      return { ...scenario, states: seen.size, transitions, properties };
    });
    return {
      tool: `Bun ${process.versions.bun}`,
      successSamples: samples.length,
      check: 'Bounded exhaustive execution of the real store, persistence and Ledger renderer',
      results,
    };
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    Date.now = originalNow;
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}
