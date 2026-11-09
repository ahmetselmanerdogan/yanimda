import { expect, type Page, test } from '@playwright/test';

import { login, newEvent, rowIds, sendSignal } from './support';

/**
 * T-026 konsol senaryoları (01 S3–S6), gerçek Keycloak + API. API kuralları hızlandırılmış koşmalı
 * (STACK_TIME_SCALE=0.1 → düşme penceresi 6 sn). Telefon araması T-050'ye kadar yok: "Ara" yalnız arama
 * başlangıcını kaydeder; S5'in sahte CPaaS ayağı telefoni modülüyle eklenecek.
 */
const PROMPT_WAIT_MS = Number(process.env.E2E_PROMPT_WAIT_MS ?? 20_000);

async function claimNew(page: Page, before: string[]) {
  const id = await newEvent(page, before);
  await page.locator(`.queue-row[data-event-id="${id}"]`).click();
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Enter');
  await expect(page.locator('.state')).toHaveText('Üstlenildi');
  return id;
}

async function closeWith(page: Page, outcome: string) {
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'Olayı kapat' });
  const choice = dialog.getByLabel(outcome);
  if (!(await choice.isChecked())) await choice.check();
  await dialog.getByRole('button', { name: 'Kapat' }).click();
  await expect(dialog).toHaveCount(0);
}

test.describe('senaryolar', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('S3 düşme, cevap yok → kuyruk; zincir: saat/telefon cevap yok, yakın ulaşıldı ve acil → 112 → kapat', async ({
    page,
  }) => {
    const before = await rowIds(page);
    await sendSignal(page, 'FALL');
    test.setTimeout(PROMPT_WAIT_MS + 60_000);
    await expect
      .poll(async () => (await rowIds(page)).length, { timeout: PROMPT_WAIT_MS })
      .toBeGreaterThan(before.length);
    const id = await claimNew(page, before);
    await page.keyboard.press('a');
    await page.keyboard.press('2'); // saat: cevap yok
    await expect(page.locator('.step.current .step-n')).toHaveText('2');
    await page.keyboard.press('2'); // telefon: cevap yok
    await expect(page.locator('.step.current .step-n')).toHaveText('3');
    await page.keyboard.press('1'); // 1. yakın: ulaşıldı
    await page.keyboard.press('2'); // → acil
    await expect(page.locator('.state')).toHaveText('Acil');
    await expect(page.locator('.step.current')).toContainText("112'yi ara");
    await expect(page.locator('.script')).toContainText('Olay: Düşme');
    await page.keyboard.press('1'); // 112 ulaşıldı
    await expect(page.locator('.state')).toHaveText('112 yönlendirildi');
    await closeWith(page, 'Acil durum (112)');
    await expect(page.locator(`.queue-row[data-event-id="${id}"]`)).toHaveCount(0);
  });

  test('S4 düşme, kullanıcı iptal eder → operatöre düşmez', async ({ page }) => {
    const before = await rowIds(page);
    const person = await sendSignal(page, 'FALL');
    await page.waitForTimeout(500);
    await sendSignal(page, 'CANCEL', person);
    await page.waitForTimeout(PROMPT_WAIT_MS / 2);
    expect((await rowIds(page)).filter((x) => !before.includes(x))).toEqual([]);
  });

  test('S5 SOS, kişi konuşabiliyor → ara, ulaşıldı + kişi iyi → kapat', async ({ page }) => {
    const before = await rowIds(page);
    await sendSignal(page, 'SOS');
    const id = await claimNew(page, before);
    await page.keyboard.press('a');
    await expect(page.locator('.step.current')).toContainText('Aranıyor');
    await page.keyboard.press('1');
    await expect(page.getByRole('group', { name: 'Ulaşıldı. Kişinin durumu?' })).toBeVisible();
    await page.keyboard.press('1'); // kişi iyi
    await expect(page.locator('.state')).toHaveText('İyi');
    await closeWith(page, 'Kişi iyi');
    await expect(page.locator(`.queue-row[data-event-id="${id}"]`)).toHaveCount(0);
  });

  test('S6 sessiz hat → Ctrl+1 gerekçeyle 112 → ulaşıldı → acil kapat (takip zorunlu)', async ({ page }) => {
    const before = await rowIds(page);
    await sendSignal(page, 'SOS');
    const id = await claimNew(page, before);
    await page.keyboard.press('a');
    await page.keyboard.press('Control+1');
    const dlg = page.getByRole('dialog', { name: "Doğrudan 112'ye aktar" });
    await dlg.getByLabel('Gerekçe (zorunlu)').fill('sessiz hat, nefes sesi');
    await dlg.getByLabel('Gerekçe (zorunlu)').press('Enter');
    await expect(page.locator('.state')).toHaveText('Acil');
    await expect(page.locator('.step').nth(1)).toContainText('Atla');
    await page.getByRole('button', { name: 'Okundu olarak işaretle' }).click();
    await page.locator('main').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('1');
    await expect(page.locator('.state')).toHaveText('112 yönlendirildi');
    await page.keyboard.press('c');
    const close = page.getByRole('dialog', { name: 'Olayı kapat' });
    await expect(close.getByRole('checkbox', { name: 'Takip araması planla' })).toBeDisabled();
    await expect(close.getByRole('checkbox', { name: 'Takip araması planla' })).toBeChecked();
    await close.getByRole('button', { name: 'Kapat' }).click();
    await expect(page.locator(`.queue-row[data-event-id="${id}"]`)).toHaveCount(0);
  });
});

test('eğitim modu: giriş ve ağ isteği yok, sahte olaylar yürütülür', async ({ page }) => {
  const apiCalls: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/v1') || u.port === '8080' || u.pathname.includes('/realms/')) apiCalls.push(r.url());
  });
  await page.goto('/?training=1');
  await expect(page.locator('.badge-training')).toHaveText('EĞİTİM MODU · gerçek olay değil');
  await expect(page.locator('.queue-row')).toHaveCount(3);
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Enter');
  await expect(page.locator('.state')).toHaveText('Üstlenildi');
  await page.keyboard.press('2');
  await expect(page.locator('.step.current .step-n')).toHaveText('2');
  await page.keyboard.press('Control+1');
  await page.getByLabel('Gerekçe (zorunlu)').fill('tatbikat');
  await page.getByLabel('Gerekçe (zorunlu)').press('Enter');
  await expect(page.locator('.script')).toContainText('Tatbikat kişisi');
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('1');
  await page.keyboard.press('c');
  await page.getByRole('dialog', { name: 'Olayı kapat' }).getByRole('button', { name: 'Kapat' }).click();
  await expect(page.locator('.queue-row')).toHaveCount(2);
  expect(apiCalls).toEqual([]);
});
