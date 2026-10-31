// Fork branding for AojdevStudio's build of the management center.
// Every brand string this fork changes reads from here, so an upstream merge
// conflicts in this file at most. index.html repeats BRAND_FULL_NAME in its
// <title> because Vite does not substitute it there.
export const BRAND_NAME = 'Irondi Analytics';
export const BRAND_FULL_NAME = `${BRAND_NAME} API Management Center`;
