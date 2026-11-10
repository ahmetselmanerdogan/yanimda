import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { login, sendSignal } from './support';

/**
 * T-074 amir panosu (E-11). Kabul: ihlal üretilince listede 5 sn içinde. Kuyruğa düşen SOS 10 sn üstlenilmezse
 * üstlenme SLA ihlalidir; pano WS'den 5 sn'de bir yenilenir.
 */
test.use({ storageState: { cookies: [], origins: [] } }); // amir ayrı oturum (operatör SSO çerezi yok)

/** Oturumdaki erişim token'ı (oidc-client-ts sessionStorage). */
const tokenOf = (page: Page) =>
  page.evaluate(() => {
    const k = Object.keys(sessionStorage).find((x) => x.startsWith('oidc.user:'));
    return k ? (JSON.parse(sessionStorage.getItem(k)!) as { access_token: string }).access_token : '';
  });

test('ihlal 5 sn içinde listede; taşma bayrağı aç/kapat', async ({ page }) => {
  test.setTimeout(150_000);
  await login(page, 'supervisor1');
  await page.getByRole('button', { name: 'Amir panosu' }).click();
  await expect(page).toHaveURL(/\/supervisor$/);
  await expect(page.getByTestId('tile-waiting')).toBeVisible();
  await expect(page.locator('.conn')).toHaveText('Canlı');
  // T-082: amir panosu da axe ciddi/kritik ihlalsiz.
  const ax = await new AxeBuilder({ page }).analyze();
  expect(
    ax.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);

  const headers = { authorization: `Bearer ${await tokenOf(page)}` };
  const ids = async () =>
    (
      (await (await page.request.get('/v1/queue?limit=200', { headers })).json()) as {
        items: { eventId: string; createdAt: string; escalatedAt: string | null }[];
      }
    ).items;
  const before = new Set((await ids()).map((i) => i.eventId));
  await sendSignal(page, 'SOS');
  let item: { eventId: string; createdAt: string; escalatedAt: string | null } | undefined;
  await expect
    .poll(async () => {
      item = (await ids()).find((i) => !before.has(i.eventId));
      return item;
    })
    .toBeTruthy();
  const breachAt = new Date(item!.escalatedAt ?? item!.createdAt).getTime() + 10_000;

  const row = page.locator(`[data-testid="sla-breach"][data-event-id="${item!.eventId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  const lag = Date.now() - breachAt;
  expect(lag).toBeLessThan(5_000 + 1_000); // 5 sn itme aralığı + çizim payı
  await expect(row).toContainText('Üstlenme > 10 sn');
  await expect(row).toContainText('Sürüyor');

  const overflow = page.getByTestId('overflow');
  await overflow.getByRole('button', { name: 'Aç' }).click();
  await expect(overflow).toContainText('Açık');
  await overflow.getByRole('button', { name: 'Kapat' }).click();
  await expect(overflow).toContainText('Kapalı');

  // Temizlik: olayı üstlenip yanlış alarm olarak kapat (sonraki senaryolar boş kuyrukla başlasın).
  const ev = `/v1/events/${item!.eventId}`;
  expect((await page.request.post(`${ev}/claim`, { headers })).status()).toBe(200);
  expect((await page.request.post(`${ev}/close`, { headers, data: { outcome: 'FALSE_ALARM' } })).status()).toBe(204);
  await expect(row).not.toContainText('Sürüyor', { timeout: 10_000 });

  await page.getByRole('button', { name: 'Konsola dön' }).click();
  await expect(page).toHaveURL(/\/$/);
});
