/**
 * Weekly quota pool for one provider: how much is left across every loaded
 * login, when it comes back, and where a burn rate would take it.
 */

import { HOUR_MS } from '@/utils/time/durations';

export type PoolProvider = 'claude' | 'codex';

/** The window each provider's pool is measured on, by the id its data layer emits. */
export const POOL_WINDOW_ID: Record<PoolProvider, string> = {
  claude: 'seven-day',
  codex: 'weekly',
};

export type PoolModel = 'all' | 'fable';

export interface PoolModelWindow {
  model: PoolModel;
  windowId: string;
  /** The usage reader records only the all-models weekly window. */
  recorded: boolean;
}

/** The pools each provider offers, the all-models pool first. */
export const POOL_MODELS: Record<PoolProvider, readonly [PoolModelWindow, ...PoolModelWindow[]]> = {
  claude: [
    { model: 'all', windowId: POOL_WINDOW_ID.claude, recorded: true },
    { model: 'fable', windowId: 'seven-day-fable', recorded: false },
  ],
  codex: [{ model: 'all', windowId: POOL_WINDOW_ID.codex, recorded: true }],
};

const WEEK_HOURS = 168;

export interface PoolLogin {
  id: string;
  name: string;
  authIndex: string | null;
}

export interface PoolCredential extends PoolLogin {
  /** Weekly percent left, 0..100. */
  leftPercent: number;
  /** Null when the backend reported no reset time. The login then has no reset events. */
  resetAtMs: number | null;
  periodMs: number;
}

export interface PoolNextReset {
  atMs: number;
  name: string;
  gainPercent: number;
}

export interface PoolSummary {
  /** Loaded logins as of the summary's now, with due resets already applied. */
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
  burnPercentPerHour: number;
}

interface WindowLike {
  id: string;
  usedPercent: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

/** A login's pool entry, or null when the pool's window has not loaded. */
export function poolCredentialOf(
  windowId: string,
  login: PoolLogin,
  windows: readonly WindowLike[]
): PoolCredential | null {
  const window = windows.find((candidate) => candidate.id === windowId);
  if (!window || window.usedPercent === null) return null;
  const periodHours =
    window.periodHours && window.periodHours > 0 ? window.periodHours : WEEK_HOURS;
  return {
    ...login,
    leftPercent: Math.min(100, Math.max(0, 100 - window.usedPercent)),
    resetAtMs: window.resetAtMs ?? null,
    periodMs: periodHours * HOUR_MS,
  };
}

/**
 * The credential as of `nowMs`. A reset at or before now has already happened,
 * so the login is full and its next reset is the first one after now.
 */
function credentialAt(credential: PoolCredential, nowMs: number): PoolCredential {
  const { resetAtMs, periodMs } = credential;
  if (resetAtMs === null || resetAtMs > nowMs) return credential;
  const periodsPassed = Math.floor((nowMs - resetAtMs) / periodMs) + 1;
  return { ...credential, leftPercent: 100, resetAtMs: resetAtMs + periodsPassed * periodMs };
}

const sumLeft = (items: readonly { leftPercent: number }[]) =>
  items.reduce((total, item) => total + item.leftPercent, 0);

export function summarizePool(
  credentials: readonly PoolCredential[],
  skippedCount: number,
  nowMs: number
): PoolSummary {
  const current = credentials.map((credential) => credentialAt(credential, nowMs));
  let nextReset: PoolNextReset | null = null;
  for (const { resetAtMs, name, leftPercent } of current) {
    if (resetAtMs !== null && (nextReset === null || resetAtMs < nextReset.atMs)) {
      nextReset = { atMs: resetAtMs, name, gainPercent: 100 - leftPercent };
    }
  }
  return {
    credentials: current,
    skippedCount,
    poolPercent: sumLeft(current),
    capPercent: current.length * 100,
    nextReset,
  };
}

/**
 * Linear level between path points. At a reset step the later point wins.
 * A time before the path starts reads the first level. That keeps every
 * interpolated segment wider than zero.
 */
export function poolLevelAt(points: readonly PoolPoint[], atMs: number): number {
  let before = points[0];
  if (atMs <= before.atMs) return before.poolPercent;
  for (const point of points) {
    if (point.atMs > atMs) {
      const ratio = (atMs - before.atMs) / (point.atMs - before.atMs);
      return before.poolPercent + (point.poolPercent - before.poolPercent) * ratio;
    }
    before = point;
  }
  return before.poolPercent;
}

/** Event guard against a pathological period turning the loop unbounded. */
const MAX_EVENTS = 10_000;

/**
 * Project the pool from now to `endMs`.
 *
 * Burn comes out of the login that resets soonest first, since its quota is
 * lost at the reset anyway. At each login's weekly reset its left returns to
 * 100, and resets repeat every period. A login with no reset time never resets
 * here, so it burns last.
 */
export function projectPool(
  credentials: readonly PoolCredential[],
  { nowMs, endMs, burnPercentPerHour }: PoolProjectionOptions
): PoolProjection {
  const state = credentials.map((credential) => {
    const { name, leftPercent, resetAtMs, periodMs } = credentialAt(credential, nowMs);
    return { name, leftPercent, periodMs, nextResetMs: resetAtMs ?? Infinity };
  });
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
