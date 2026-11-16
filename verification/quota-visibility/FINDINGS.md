# Claude quota visibility findings

Product commit `32ce68646e26aa75acc520a0afdde23575ca9f67` does not satisfy unconditional quota visibility.
The checker executes real product functions and the Ledger server renderer. It is a finite execution check, not an unbounded proof.

## Results

Regenerate the JSON with the command in [the skill](../../.agents/skills/prove-quota-visibility/SKILL.md).

| Property                      | Result in the stated bounds                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `QUOTA_ALWAYS_VISIBLE`        | Fails on a first 429 with no observation.                                                        |
| `KNOWN_VALUES_RETAINED`       | Passes during refresh and 429 handling within one process.                                       |
| `KNOWN_VALUES_SURVIVE_RELOAD` | Fails before the delayed save runs. Also fails when remember password is off.                    |
| `SAVED_VALUES_SURVIVE_RELOAD` | Fails when the save timer runs while quota is loading. Not exercised with remember password off. |
| `NO_INVENTED_QUOTA`           | Passes. An unknown quota is not rendered as a percentage.                                        |

The two substantive passing properties each failed after a mutation in their real product source.
After the scratch files were restored, the original results returned.

## Cold read returns 429

1. Open this backend in a browser with no saved observation.
2. Start a Claude quota refresh.
3. Receive upstream 429.
4. The Ledger shows the read error in place of percentage cells.

This is an unmet availability requirement under the checker's inputs.
It is not evidence that the UI should invent values.
The current browser-local source has no percentage to display in this state.

## Reload precedes the first save

1. Receive a successful observation.
2. Reload before the one-second save timer fires.
3. The previous process's in-memory value is gone and no saved observation exists.

`startQuotaPersistence` delays writes in `src/features/quota/quotaPersistence.ts`.
The checker cancels that process's timer on reload, then calls the real `restoreQuotaCache`.
Without remember password, the save path deliberately removes the saved copy instead.

## A save during loading drops retained values

1. Receive a successful observation.
2. Start a new manual refresh. `setClaudeQuota` retains the previous windows and `observedAt`.
3. Let the one-second save timer fire while the refresh is still pending.
4. The save filter excludes the loading entry, so the stored map loses it.
5. Reload. The Ledger has no windows to restore.

The `save` filter in `quotaPersistence.ts` accepts success states and dated stale error states.
It excludes loading states even when `setClaudeQuota` in `useQuotaStore.ts` retained their valid observation.
A background refresh of a successful card skips the loading state. This finding concerns manual and other non-background loads.

Reproduce with real timers rather than the checker's clock:

```bash
mise exec bun@1.4.3 -- bun verification/quota-visibility/reproduce-loading-save.ts
```

Exit 1 reports lost quota. Exit 0 means the retained quota survives. Exit 2 means the reproduction could not run.
It first waited for a valid quota to be saved, then refreshed and waited for the next save.
The stored observation disappeared while the in-memory value remained. Reload then restored no quota.
No product file was changed for that reproduction.

## Event mapping and assumptions

| Event         | Real calls                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Refresh start | `CLAUDE_CONFIG.buildLoadingState`, `setClaudeQuota`                                                                                |
| Success       | `CLAUDE_CONFIG.buildSuccessState`, `setClaudeQuota`, `markQuotaSettled`                                                            |
| 429           | `CLAUDE_CONFIG.buildErrorState`, `setClaudeQuota`, `markQuotaSettled`                                                              |
| Save timer    | Callback registered by `startQuotaPersistence`, including its real serialization and filter                                        |
| Reload        | Stop the old subscriptions and timer, reset the store to its initial state, call `restoreQuotaCache`, then start new subscriptions |

Each event is one synchronous JavaScript step. Success and failure commit their quota state and settlement without an `await` between them.
The literal `QUOTA_ALWAYS_VISIBLE` predicate checks only settled reads. It excludes initial states, pending reads, and post-reload states before another read settles.
Separate retention properties check known values during loading and after reload.
The checker enumerates the permitted orders of these steps. It does not execute the request-owning hooks.
The identity is stable throughout a scenario, and storage reads and writes succeed.

Three scenarios cover one remembered credential at depth six, two remembered credentials at depth five, and one unremembered credential at depth five.
There are three concrete observations and a 429 outcome. Other numbers, error codes, and lifecycle events are outside the scope.
The search key includes the quota store, storage bytes, timer state, pending reads, history needed by the properties, and the reload flag.
If two paths share a key but differ in enabled events or violations, the checker fails with an error.

Full browser mounting, authentication, network retries, account replacement, tab coordination, and other providers remain outside this check.
The repository's issue tracker was disabled when this finding was recorded. The verification PR carries these findings without a product fix.
