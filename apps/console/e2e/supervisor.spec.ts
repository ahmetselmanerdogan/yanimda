import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { AUTH_STATE, login, rowIds, sendSignal } from './support';

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

test('otomatik atama: amir açar; SOS konsolu açık operatöre atanır, geri sayımla "Kabul et"; amir kapatır', async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  // Operatör ayrı oturumda (global kurulumdaki operatör SSO çerezi), konsol bağlı ve müsait.
  const opCtx = await browser.newContext({ storageState: AUTH_STATE });
  const op = await opCtx.newPage();
  let supHeaders: Record<string, string> | undefined;
  try {
    await login(op);
    const opHeaders = { authorization: `Bearer ${await tokenOf(op)}`, 'content-type': 'application/json' };
    const me = await (await op.request.get('/v1/operators/me', { headers: opHeaders })).json();
    expect(me.status).toBe('AVAILABLE');
    // Başlangıç: önceki testlerden kalan olaylar (ör. axe testinin üstlenip bıraktığı SOS) kapatılır; elinde süren
    // olayı olan operatöre atama yapılmaz, kuyrukta bekleyen eski olay da yeni SOS'tan önce atanırdı.
    const { items } = (await (await op.request.get('/v1/queue?limit=200', { headers: opHeaders })).json()) as {
      items: { eventId: string; state: string; lockedBy: string | null }[];
    };
    for (const i of items) {
      // Atamayı engelleyen: kuyrukta bekleyen ve operatörün yürüttüğü (Üstlenildi / Zincir) olaylar.
      const mine = i.lockedBy === me.subject && ['OPERATOR_ASSIGNED', 'CONTACT_CHAIN'].includes(i.state);
      if (i.state !== 'OPERATOR_QUEUE' && !mine) continue;
      const ev = `/v1/events/${i.eventId}`;
      if (!mine) expect((await op.request.post(`${ev}/claim`, { headers: opHeaders })).status()).toBe(200);
      const r = await op.request.post(`${ev}/close`, { headers: opHeaders, data: { outcome: 'FALSE_ALARM' } });
      expect(r.status()).toBe(204);
    }

    await login(page, 'supervisor1');
    supHeaders = { authorization: `Bearer ${await tokenOf(page)}`, 'content-type': 'application/json' };
    await page.getByRole('button', { name: 'Amir panosu' }).click();
    const tile = page.getByTestId('auto-assign');
    await expect(tile).toContainText('Kapalı');
    // Kabul sayısı göreli: yeniden denemede (CI retries) veya dolu yerel veritabanında önceki kabuller sayılır.
    const accepted = async () => Number(/(\d+) kabul/.exec(await tile.innerText())?.[1] ?? NaN);
    const acceptedBefore = await accepted();
    await tile.getByRole('button', { name: 'Aç' }).click();
    await expect(tile).toContainText('Açık');

    // Operatör moladan dönerken "Müsait"e tıklar: odak o düğmede kalır. Teklif gelince Enter "Kabul et" olmalı
    // (uçtan uca emülatör koşusu 2026-11-14: Enter odaklı "Müsait"e gidiyor, teklif cevapsız düşüyordu).
    await op.getByRole('button', { name: 'Müsait' }).click();
    await expect(op.getByRole('button', { name: 'Müsait' })).toBeFocused();
    const before = await rowIds(op);
    await sendSignal(op, 'SOS');
    const offer = op.getByTestId('offer');
    await expect(offer).toBeVisible({ timeout: 15_000 }); // atama turu 2 sn + WS
    await expect(offer).toContainText('Bu olay size atandı');
    const id = (await rowIds(op)).find((x) => !before.includes(x))!;
    await expect(op.locator(`.queue-row[data-event-id="${id}"]`)).toHaveClass(/active/);
    await expect(offer.getByRole('button', { name: /Kabul et/ })).toBeFocused();
    await op.keyboard.press('Enter');
    await expect(offer).toHaveCount(0);
    await expect(op.locator('.state')).toHaveText('Üstlenildi');

    await tile.getByRole('button', { name: 'Kapat' }).click({ timeout: 10_000 });
    await expect(tile).toContainText('Kapalı');
    await expect.poll(accepted, { timeout: 10_000 }).toBe(acceptedBefore + 1);

    // Temizlik: operatör olayı yanlış alarm olarak kapatır.
    const r = await op.request.post(`/v1/events/${id}/close`, { headers: opHeaders, data: { outcome: 'FALSE_ALARM' } });
    expect(r.status()).toBe(204);
    await expect(op.locator(`.queue-row[data-event-id="${id}"]`)).toHaveCount(0);
  } finally {
    // Bayrak açık kalmasın (yeniden deneme ve sonraki koşular kapalıyla başlar).
    if (supHeaders)
      await page.request.put('/v1/supervisor/auto-assign', { headers: supHeaders, data: { enabled: false } });
    await opCtx.close();
  }
});
