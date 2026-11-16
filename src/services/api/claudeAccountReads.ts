import { apiClient } from './client';
import { apiCallApi, type ApiCallRequest, type ApiCallResult } from './apiCall';
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_REQUEST_HEADERS,
  CLAUDE_USAGE_URL,
} from '@/utils/quota/constants';

export const CLAUDE_OBSERVATION_TTL_MS = 5 * 60 * 1000;
export const CLAUDE_OBSERVATION_URL = `${CLAUDE_USAGE_URL}?cedar_ember=1`;

type Endpoint = 'usage' | 'profile';
type Observation = { response: ApiCallResult; observedAt: string };
type Retry = { observation: Observation; until: number };
type ReadState = {
  cached: { observation: Observation; until: number } | null;
  pending: { promise: Promise<Observation>; fresh: boolean } | null;
  retry: Retry | null;
};
type Account = { files: Set<string>; usage: ReadState; profile: ReadState };
const emptyRead = (retry: Retry | null = null): ReadState => ({
  cached: null,
  pending: null,
  retry,
});

const dependencies = {
  revision: () => apiClient.getConnectionRevision(),
  now: () => Date.now(),
  request: (request: ApiCallRequest) => apiCallApi.request(request, { timeout: 12000 }),
};

function retryDeadline(response: ApiCallResult, now: number): number {
  const value = Object.entries(response.header).find(
    ([name]) => name.toLowerCase() === 'retry-after'
  )?.[1][0];
  const seconds = Number(value);
  const delay = value?.trim()
    ? Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(value) - now
    : 0;
  return now + Math.max(CLAUDE_OBSERVATION_TTL_MS, Number.isFinite(delay) ? delay : 0);
}

/** Quota and reset displays consume one observation from the same rate-limited endpoint. */
export function createClaudeAccountReads(deps = dependencies) {
  let revision = deps.revision();
  const accounts = new Map<string, Account>();
  const syncSession = () => {
    if (revision !== deps.revision()) {
      revision = deps.revision();
      accounts.clear();
    }
    return revision;
  };
  const invalidate = (authIndex: string) => {
    const account = accounts.get(authIndex);
    if (!account) return;
    accounts.set(authIndex, {
      files: account.files,
      usage: emptyRead(account.usage.retry),
      profile: emptyRead(account.profile.retry),
    });
  };
  const reader = {
    invalidate(authIndex: string) {
      syncSession();
      invalidate(authIndex);
    },
    clear(names?: string[]) {
      syncSession();
      for (const [authIndex, account] of accounts) {
        if (!names || names.some((name) => account.files.has(name))) invalidate(authIndex);
      }
    },
    read(
      authIndex: string,
      endpoint: Endpoint,
      options: { fileName?: string; fresh?: boolean } = {}
    ): Promise<Observation> {
      const session = syncSession();
      let account = accounts.get(authIndex);
      if (!account) {
        account = { files: new Set(), usage: emptyRead(), profile: emptyRead() };
        accounts.set(authIndex, account);
      }
      const owner = account;
      if (options.fileName) owner.files.add(options.fileName);
      const state = owner[endpoint];
      const now = deps.now();
      if (!options.fresh && state.cached && state.cached.until > now) {
        return Promise.resolve(state.cached.observation);
      }
      if (state.retry && state.retry.until > now) return Promise.resolve(state.retry.observation);
      if (state.pending) {
        return options.fresh || state.pending.fresh
          ? state.pending.promise.then(() => reader.read(authIndex, endpoint, options))
          : state.pending.promise;
      }
      const current = () => deps.revision() === session && accounts.get(authIndex) === owner;
      const request = deps
        .request({
          authIndex,
          method: 'GET',
          url:
            endpoint === 'profile'
              ? CLAUDE_PROFILE_URL
              : `${CLAUDE_OBSERVATION_URL}${options.fresh ? '&skip_spend=1' : ''}`,
          header: { ...CLAUDE_REQUEST_HEADERS, Accept: 'application/json' },
        })
        .then((response) => {
          if (!current()) throw new Error('Claude account observation invalidated');
          const observed = deps.now();
          const observation = { response, observedAt: new Date(observed).toISOString() };
          if (response.statusCode === 429) {
            state.retry = {
              observation,
              until: Math.max(state.retry?.until ?? 0, retryDeadline(response, observed)),
            };
          } else if (response.statusCode >= 200 && response.statusCode < 300) {
            state.retry = null;
            if (!options.fresh || endpoint === 'profile') {
              state.cached = { observation, until: observed + CLAUDE_OBSERVATION_TTL_MS };
            }
          }
          return observation;
        })
        .finally(() => {
          if (current() && state.pending?.promise === request) state.pending = null;
        });
      state.pending = { promise: request, fresh: options.fresh === true };
      return request;
    },
  };
  return reader;
}

export const claudeAccountReads = createClaudeAccountReads();
