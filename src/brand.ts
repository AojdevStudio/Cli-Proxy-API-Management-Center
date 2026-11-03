// Fork branding for AojdevStudio's build of the management center.
// This file is fork-only, so upstream merges never conflict here. Each place
// that shows the brand is a one-line edit that reads these constants, and
// tests/brand.test.ts fails if a merge brings a stock name back.
// index.html repeats BRAND_FULL_NAME in <title>, since a TS constant cannot be read there.
// Logo and favicon: both come from INLINE_LOGO_JPEG in src/assets/logoInline.ts
// (src/main.tsx sets the favicon from it at startup).
export const BRAND_NAME = 'Irondi Analytics';
export const BRAND_FULL_NAME = `${BRAND_NAME} API Management Center`;
