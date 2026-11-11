/**
 * Weekly quota pool for one provider: how much is left across every loaded
 * login, when it comes back, and where a burn rate would take it.
 *
 * React-free and clock-free. `nowMs` is always passed in.
 *
 * The panel records no quota history yet, so the burn rate is a parameter that
 * callers pass as 0 until the usage reader serves a series. `PoolHistoryPoint`
 * is the shape that series will arrive in.
 */

import { HOUR_MS } from '@/utils/time/durations';

export type PoolProvider = 'claude' | 'codex';

/** The window each provider's pool is measured on, by the id its data layer emits. */
export const POOL_WINDOW_ID: Record<PoolProvider, string> = {
  claude: 'seven-day',
  codex: 'weekly',
};

const WEEK_HOURS = 168;

/** One login's weekly window, the only thing the pool reads. */
export interface PoolCredential {
  id: string;
  name: string;
  /** Weekly percent left, 0..100. */
  leftPercent: number;
  resetAtMs: number;
  periodMs: number;
}

/** A recorded pool level. The usage reader will serve these later. */
export interface PoolHistoryPoint {
  atMs: number;
  poolPercent: number;
}

export interface PoolNextReset {
  atMs: number;
  name: string;
  gainPercent: number;
}

export interface PoolSummary {
  credentials: PoolCredential[];
  /** Logins of this provider whose weekly window has not loaded. */
  skippedCount: number;
  poolPercent: number;
  capPercent: number;
  nextReset: PoolNextReset | null;
}

export interface PoolPoint {
  atMs: number;
  poolPercent: number;
}

export interface PoolResetStep {
  atMs: number;
  name: string;
  gainPercent: number;
  /** Pool level right after the step. */
  poolPercent: number;
}

export interface PoolProjection {
  /** Piecewise-linear path. A reset appears as two points at the same instant. */
  points: PoolPoint[];
  steps: PoolResetStep[];
  poolEmptyMs: number | null;
  firstEmpty: { atMs: number; name: string } | null;
}

export interface PoolProjectionOptions {
  nowMs: number;
  endMs: number;
  /** Pool percent used per hour. 0 until a history series exists. */
  burnPercentPerHour: number;
}

interface WindowLike {
  id: string;
  usedPercent: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

/** A login's pool entry, or null when its weekly window has not loaded. */
export function poolCredentialOf(
  provider: PoolProvider,
  id: string,
  name: string,
  windows: readonly WindowLike[]
): PoolCredential | null {
  const window = windows.find((candidate) => candidate.id === POOL_WINDOW_ID[provider]);
  if (!window || window.usedPercent === null || typeof window.resetAtMs !== 'number') return null;
  const periodHours =
    window.periodHours && window.periodHours > 0 ? window.periodHours : WEEK_HOURS;
  return {
    id,
    name,
    leftPercent: Math.min(100, Math.max(0, 100 - window.usedPercent)),
    resetAtMs: window.resetAtMs,
    periodMs: periodHours * HOUR_MS,
  };
}

const sumLeft = (items: readonly { leftPercent: number }[]) =>
  items.reduce((total, item) => total + item.leftPercent, 0);

export function summarizePool(
  credentials: readonly PoolCredential[],
  skippedCount: number
): PoolSummary {
  const soonest = credentials.reduce<PoolCredential | null>(
    (best, credential) => (best && best.resetAtMs <= credential.resetAtMs ? best : credential),
    null
  );
  return {
    credentials: [...credentials],
    skippedCount,
    poolPercent: sumLeft(credentials),
    capPercent: credentials.length * 100,
    nextReset: soonest && {
      atMs: soonest.resetAtMs,
      name: soonest.name,
      gainPercent: 100 - soonest.leftPercent,
    },
  };
}

/** Event guard against a pathological period turning the loop unbounded. */
const MAX_EVENTS = 10_000;

/**
 * Project the pool from now to `endMs`.
 *
 * Burn comes out of the login that resets soonest first, since its quota is
 * lost at the reset anyway. At each login's weekly reset its left returns to
 * 100, and resets repeat every period.
 */
export function projectPool(
  credentials: readonly PoolCredential[],
  { nowMs, endMs, burnPercentPerHour }: PoolProjectionOptions
): PoolProjection {
  const state = credentials.map((credential) => ({
    name: credential.name,
    leftPercent: credential.leftPercent,
    periodMs: credential.periodMs,
    nextResetMs:
      credential.resetAtMs > nowMs
        ? credential.resetAtMs
        : credential.resetAtMs +
          Math.floor((nowMs - credential.resetAtMs) / credential.periodMs + 1) *
            credential.periodMs,
  }));
  const point = (atMs: number): PoolPoint => ({ atMs, poolPercent: sumLeft(state) });

  const points = [point(nowMs)];
  const steps: PoolResetStep[] = [];
  const alreadyEmpty = state.find((entry) => entry.leftPercent <= 0);
  let firstEmpty = alreadyEmpty ? { atMs: nowMs, name: alreadyEmpty.name } : null;
  let poolEmptyMs = state.length > 0 && sumLeft(state) <= 0 ? nowMs : null;

  let t = nowMs;
  for (let events = 0; t < endMs && state.length > 0 && events < MAX_EVENTS; events += 1) {
    const draining =
      burnPercentPerHour > 0
        ? state
            .filter((entry) => entry.leftPercent > 0)
            .reduce<(typeof state)[number] | null>(
              (best, entry) => (best && best.nextResetMs <= entry.nextResetMs ? best : entry),
              null
            )
        : null;
    const resetMs = Math.min(...state.map((entry) => entry.nextResetMs));
    const drainMs = draining ? t + (draining.leftPercent / burnPercentPerHour) * HOUR_MS : Infinity;
    const nextMs = Math.min(resetMs, drainMs, endMs);

    if (draining) {
      draining.leftPercent =
        nextMs === drainMs
          ? 0
          : Math.max(0, draining.leftPercent - ((nextMs - t) / HOUR_MS) * burnPercentPerHour);
    }
    t = nextMs;

    if (draining && nextMs === drainMs) {
      points.push(point(t));
      firstEmpty ??= { atMs: t, name: draining.name };
      if (sumLeft(state) <= 0) poolEmptyMs ??= t;
    } else if (nextMs === resetMs && t < endMs) {
      points.push(point(t));
      state
        .filter((entry) => entry.nextResetMs === t)
        .forEach((entry) => {
          const gainPercent = 100 - entry.leftPercent;
          entry.leftPercent = 100;
          entry.nextResetMs += entry.periodMs;
          steps.push({ atMs: t, name: entry.name, gainPercent, poolPercent: sumLeft(state) });
        });
      points.push(point(t));
    } else {
      points.push(point(t));
    }
  }

  return { points, steps, poolEmptyMs, firstEmpty };
}
