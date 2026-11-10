import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/** Duyarlı düzen: her boyutta görünür bölmeler, yatay kaydırma yok, axe ciddi/kritik 0, dokunma hedefi ≥ 44 px. */
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/?training=1');
  await expect(page.locator('.queue-row').first()).toBeVisible();
});

test('düzen ve üstlenme akışı', async ({ page }, info) => {
  const layout = page.locator('.layout');
  const v = info.project.name;
  await expect(layout).toHaveAttribute(
    'data-viewport',
    v === 'masaustu' ? 'desktop' : v === 'tablet' ? 'tablet' : 'phone',
  );
  expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);

  if (v === 'masaustu') {
    await expect(page.locator('.queue')).toBeVisible();
    await expect(page.locator('.center')).toBeVisible();
    await expect(page.locator('#person-panel')).toBeVisible();
    await expect(page.locator('.tabbar')).toBeHidden();
  }
  if (v === 'tablet') {
    await expect(page.locator('.queue')).toBeVisible();
    await expect(page.locator('.center')).toBeVisible();
    await expect(page.locator('#person-panel')).not.toBeInViewport();
    await page.getByRole('button', { name: 'Kişi', exact: true }).click();
    await expect(page.locator('#person-panel')).toBeInViewport();
  }
  if (v === 'telefon') {
    const tabs = page.getByRole('navigation', { name: 'Bölümler' });
    await expect(tabs).toBeVisible();
    await expect(page.locator('.queue')).toBeVisible();
    await expect(page.locator('.center')).toBeHidden();
    await page.locator('.queue-row').first().tap();
    await expect(page.locator('.center')).toBeVisible();
    await expect(page.locator('.queue')).toBeHidden();
    await tabs.getByRole('button', { name: 'Kişi' }).tap();
    await expect(page.locator('#person-panel')).toBeVisible();
    await tabs.getByRole('button', { name: 'Olay' }).tap();
  } else {
    await page.locator('.queue-row').first().click();
  }

  // Üstlen (her boyutta dokunarak / tıklayarak) → adım düğmeleri görünür ve yeterince büyük.
  const claim = page.getByRole('button', { name: /Üstlen/ });
  await claim.click();
  await expect(page.locator('.state')).toHaveText('Üstlenildi');
  const callBtn = page.locator('.step-actions button').first();
  await expect(callBtn).toBeVisible();
  if (v !== 'masaustu') {
    const box = (await callBtn.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);
  await axe(page);
});

test('kapatma penceresi telefonda tam ekran, her boyutta erişilebilir', async ({ page }, info) => {
  if (info.project.name === 'telefon') await page.locator('.queue-row').first().tap();
  else await page.locator('.queue-row').first().click();
  await page.getByRole('button', { name: /Üstlen/ }).click();
  await page.getByRole('button', { name: /Kapat/ }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Olayı kapat' });
  await expect(dlg).toBeVisible();
  if (info.project.name === 'telefon') {
    const box = (await dlg.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual((page.viewportSize()?.width ?? 0) - 1);
  }
  await axe(page);
});

test('PWA: manifest, simge ve service worker yayınlanır; API önbellek dışı', async ({ page, request }) => {
  test.skip(test.info().project.name !== 'masaustu', 'bir kez yeter');
  await page.goto('/?training=1');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const m = (await (await request.get(href!)).json()) as {
    name: string;
    display: string;
    icons: unknown[];
    start_url: string;
  };
  expect(m).toMatchObject({ name: 'Yanımda Konsol', display: 'standalone', start_url: '/' });
  expect(m.icons.length).toBeGreaterThanOrEqual(2);
  expect((await request.get('/icon.svg')).ok()).toBe(true);
  const sw = await (await request.get('/sw.js')).text();
  expect(sw).toContain('/^\\/v1\\//');
});
