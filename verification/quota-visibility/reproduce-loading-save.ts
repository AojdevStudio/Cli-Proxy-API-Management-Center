import assert from 'node:assert/strict';
import process from 'node:process';

async function main() {
  const { CLAUDE_CONFIG } = await import('@/features/quota/providers/claude/data');
  const { restoreQuotaCache, startQuotaPersistence } =
    await import('@/features/quota/quotaPersistence');
  const { useAuthStore } = await import('@/stores/useAuthStore');
  const { markQuotaSettled, useQuotaStore } = await import('@/stores/useQuotaStore');
  const { isRecord } = await import('@/utils/helpers');
  const storage = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const name = 'claude-real-timer-proof.json';
  const apiBase = 'https://quota-verification.invalid';
  const initial = useQuotaStore.getInitialState();
  let stop = () => {};
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });

  function savedObservation(): unknown {
    const saved: unknown = JSON.parse(storage.get('quotaCache.v1') ?? 'null');
    assert(isRecord(saved) && isRecord(saved.maps) && isRecord(saved.maps.claudeQuota));
    return saved.maps.claudeQuota[name];
  }

  try {
    useQuotaStore.setState(initial, true);
    useAuthStore.setState({ isAuthenticated: true, apiBase, rememberPassword: true });
    stop = startQuotaPersistence();
    const observation = {
      observedAt: new Date().toISOString(),
      windows: [{ id: 'seven-day', label: 'Weekly', usedPercent: 50, resetLabel: '3d' }],
      dollarWindows: [],
    };
    useQuotaStore.getState().setClaudeQuota({
      [name]: CLAUDE_CONFIG.buildSuccessState(observation),
    });
    markQuotaSettled([name]);
    await Bun.sleep(1100);
    assert(savedObservation(), 'The first real save must store the good quota');
    useQuotaStore.getState().setClaudeQuota({ [name]: CLAUDE_CONFIG.buildLoadingState() });
    assert.deepEqual(useQuotaStore.getState().claudeQuota[name].windows, observation.windows);
    await Bun.sleep(1100);
    const savedQuotaErasedDuringRefresh = savedObservation() === undefined;
    stop();
    useQuotaStore.setState(initial, true);
    restoreQuotaCache(apiBase);
    const quotaMissingAfterReload = !useQuotaStore.getState().claudeQuota[name]?.windows.length;
    console.log(
      JSON.stringify({
        realSaveTimerUsed: true,
        goodQuotaSavedFirst: true,
        inMemoryQuotaRetainedDuringRefresh: true,
        savedQuotaErasedDuringRefresh,
        quotaMissingAfterReload,
      })
    );
    if (savedQuotaErasedDuringRefresh || quotaMissingAfterReload) process.exitCode = 1;
  } finally {
    stop();
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

try {
  await main();
} catch (error) {
  console.error(String(error));
  process.exitCode = 2;
}
