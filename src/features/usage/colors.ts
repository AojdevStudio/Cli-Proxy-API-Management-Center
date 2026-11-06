/**
 * Usage page colors. Brand colors mark provider identity only. Status colors
 * mark state only, never share a hue with a brand color, and always appear
 * next to a word that says the same thing.
 */

export type BrandId = 'anthropic' | 'openai' | 'other';

/**
 * One map, one source per value.
 * - anthropic: github.com/anthropics/skills, skills/brand-guidelines/SKILL.md,
 *   "Orange: #d97757, Primary accent".
 * - openai: openai.com/brand lists no accent color and says not to add colors to
 *   the Blossom or the wordmark, so Codex stays monochrome in the theme's primary
 *   text color (dark on light, light on dark).
 * - other: neutral gray until a provider's value is added here with its source.
 * No provider logos anywhere, because OpenAI's usage terms restrict them.
 */
export const BRAND_COLORS: Record<BrandId, string> = {
  anthropic: '#d97757',
  openai: 'var(--text-primary)',
  other: 'var(--text-tertiary)',
};

export type StatusTone = 'danger' | 'warn';

/**
 * Picked for this page, not taken from the theme: the theme's warning and error
 * color (#c65746) shares Claude's orange hue. danger sits at hue 315 (magenta),
 * warn at hue 215 (blue), both far from 15 (Claude). Each pair passes WCAG AA
 * text contrast on every theme background (checked in tests/usageLogic.test.ts).
 */
export const STATUS_COLORS: Record<StatusTone, { light: string; dark: string }> = {
  danger: { light: '#9b1b7c', dark: '#f27fd2' },
  warn: { light: '#1f5fae', dark: '#7fb2ff' },
};

const ANTHROPIC_KEYS = /^(claude|anthropic)/i;
const OPENAI_KEYS = /^(codex|openai|gpt|o\d|chatgpt)/i;

/** Brand for a provider key or a model name. */
export const brandFor = (key: string): BrandId =>
  ANTHROPIC_KEYS.test(key) ? 'anthropic' : OPENAI_KEYS.test(key) ? 'openai' : 'other';
