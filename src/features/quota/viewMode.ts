/** Quota page layout, remembered per viewer in localStorage. */

export const QUOTA_VIEW_MODES = ['ledger', 'cards'] as const;

export type QuotaViewMode = (typeof QUOTA_VIEW_MODES)[number];

const QUOTA_VIEW_MODE_KEY = 'quotaPage.viewMode';

/** Storage can be missing, blocked, or cleared, and the page must still render. */
export const readQuotaViewMode = (): QuotaViewMode => {
  try {
    return window.localStorage.getItem(QUOTA_VIEW_MODE_KEY) === 'cards' ? 'cards' : 'ledger';
  } catch {
    return 'ledger';
  }
};

export const writeQuotaViewMode = (mode: QuotaViewMode) => {
  try {
    window.localStorage.setItem(QUOTA_VIEW_MODE_KEY, mode);
  } catch {
    // The choice still applies for this visit. It is only a convenience to keep it.
  }
};
