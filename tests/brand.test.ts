import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { BRAND_FULL_NAME } from '@/brand';

// Fork guard: an upstream merge that brings back a stock brand string fails here.
// Strings that name the backend (upgrade hints, version labels) are not the brand
// and stay as they are.
const STOCK_BRAND_STRINGS = ['CLI Proxy API Management Center', 'Welcome to CLI Proxy API'];

describe('fork brand', () => {
  test('no stock product name is left in the app source', async () => {
    const hits: string[] = [];
    for await (const path of new Glob('src/**/*.{ts,tsx}').scan('.')) {
      const source = await Bun.file(path).text();
      for (const stock of STOCK_BRAND_STRINGS) {
        if (source.includes(stock)) hits.push(`${path}: ${stock}`);
      }
    }
    expect(hits).toEqual([]);
  });

  test('the browser tab shows the brand before the app loads', async () => {
    const html = await Bun.file('index.html').text();
    expect(html).toContain(`<title>${BRAND_FULL_NAME}</title>`);
  });

  test('the sidebar and the auto-login splash show the brand name', async () => {
    const layout = await Bun.file('src/components/layout/MainLayout.tsx').text();
    expect(layout).toContain('<span className="sidebar-brand-title">{BRAND_NAME}</span>');
    const login = await Bun.file('src/pages/LoginPage.tsx').text();
    expect(login).toContain('<h1 className={styles.splashTitle}>{BRAND_NAME}</h1>');
  });
});
