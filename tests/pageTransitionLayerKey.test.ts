import { expect, test } from 'bun:test';
import { layerKeyOf } from '@/components/common/PageTransitionLayer';

test('hash changes the router did not push still get their own layer', () => {
  // Typed URLs, pasted links, and back to the first entry all arrive with the key "default".
  const quota = layerKeyOf({ key: 'default', pathname: '/quota' });
  const dashboard = layerKeyOf({ key: 'default', pathname: '/' });
  expect(quota).not.toBe(dashboard);
  expect(layerKeyOf({ key: 'default', pathname: '/quota' })).toBe(quota);
});
