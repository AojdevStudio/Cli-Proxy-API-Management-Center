---
name: prove-quota-visibility
description: Verify Claude quota visibility through refreshes and reloads.
---

# Prove quota visibility

Use this skill when changes touch Claude quota retention, persistence, state builders, or Ledger percentage rendering.
The requirement is that quota stays visible. Lost values hide available account capacity from the owner.

## Run the check

From the repository root, use the package's pinned Bun 1.4.3 and locked dependencies.

```bash
mise exec bun@1.4.3 -- bun verification/quota-visibility/check.ts
```

This command exhausts the finite event scopes below against real product functions and prints JSON.
It changes only an isolated process's stores, storage boundary, and clock. It sends no provider requests.

Read every property's `counterexample` in every scenario.
Each counterexample lists the shortest event sequence found, the credential, expected values, and actual state and percentages.
Exit 0 means no violation in these bounds. Exit 1 means a property failed. Exit 2 means the checker itself failed.

Current product findings are recorded in [FINDINGS.md](../../../verification/quota-visibility/FINDINGS.md).
Keep failures visible. An initial 429 with no observation violates literal availability, while an invented percentage violates `NO_INVENTED_QUOTA`.
A valid cached source is needed to satisfy both in that case. Requiring a previous observation would change the owner's requirement.

## Check the checker

```bash
mise exec bun@1.4.3 -- bun verification/quota-visibility/mutation-test.ts
```

This command copies the relevant project files into a temporary directory, breaks real product code, and reruns the check.
It disables store retention and adds an invented percentage to the Ledger's unknown state.
Each mutation must break its property in every scenario where that property passed.
The command restores each scratch file, confirms the original findings return, and removes its temporary directory.
A successful mutation run validates fault detection. It does not mean the product properties passed.

The saved-values property is not exercised when remember password is off, because that scenario never saves an observation.
Its null counterexample in that scenario is not evidence of retention.

## Keep the coverage in sync

Last confirmed product commit: `32ce68646e26aa75acc520a0afdde23575ca9f67`.

| Covered file                                  | Functions or behavior                                       |
| --------------------------------------------- | ----------------------------------------------------------- |
| `src/stores/useQuotaStore.ts`                 | `setClaudeQuota`, `markQuotaSettled`                        |
| `src/features/quota/providers/claude/data.ts` | `CLAUDE_CONFIG` loading, success, and error builders        |
| `src/features/quota/quotaPersistence.ts`      | `startQuotaPersistence`, save callback, `restoreQuotaCache` |
| `src/features/quota/ledger/LedgerPanel.tsx`   | `LedgerRow`, `LimitCell`                                    |
| `src/features/quota/ledger/ledgerModel.ts`    | `ledgerLimit`, `ledgerPool`                                 |

Before trusting a result after covered code changes, inspect the diff from that commit.
Confirm that the checker still calls the real actions and captures every state value that affects its properties or enabled events.
The [coverage and scope record](../../../verification/quota-visibility/FINDINGS.md) maps events to product calls.
Move the sync commit forward only after that review, a fresh checker run, and successful mutation detection.
If a formerly failing property passes, add a real-code mutation that breaks it before calling that property verified.
Use `/t3-pstack:maintain-formal-verification-skill` when earlier changes did not update this record.

## Bounds and interpretation

The checker explores one credential through six events, two credentials through five events, and one unremembered credential through five events.
Events are refresh start, one of three successful observations, upstream 429, the save timer firing, and reload.
The observations include weekly use of 0%, 50%, and 100%, plus a 95% Fable window.

The store, persistence code, state builders, pool calculation, and React server renderer are real.
The clock, storage, request completion inputs, and browser reload are controlled boundaries.
Reload treats authentication as complete and attempts `restoreQuotaCache` for the same backend.
The real application restores only on a successful remembered-session resume. The unremembered scenario is a generous restoration assumption, not a test of login.

These are bounded execution checks, not an unbounded proof of TypeScript or the browser.
They exclude network scheduling, request supersession, connection changes, deletion, logout, list loading, browser effects, CSS, other providers, and reset spending.
The repository's TypeScript check covers `src`, not these standalone scripts. Bun execution, mutation tests, and lint validate the scripts.
