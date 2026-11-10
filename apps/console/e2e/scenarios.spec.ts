import { expect, type Page, test } from '@playwright/test';

import { login, newEvent, rowIds, sendSignal } from './support';

/**
 * T-026 konsol senaryoları (01 S3–S6), gerçek Keycloak + API. API kuralları hızlandırılmış koşmalı
 * (STACK_TIME_SCALE=0.1 → düşme penceresi 6 sn). S5 sahte CPaaS ile (T-050): ADMIN_TOKEN verilirse kişinin numarası
 * yüklenir, "Ara" gerçek arama akışını (çalıyor → görüşme → bitti → kayıt) yürütür, öneri onaylanır.
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
    // T-052: 112 masa sabit hattından, manuel işaretli.
    await expect(page.locator('.step.current .badge-manual')).toHaveText('MANUEL');
    await expect(page.getByTestId('desk-112')).toContainText('masadaki sabit hattan');
    await expect(page.getByRole('button', { name: /Sabit hattan aradım/ })).toBeVisible();
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

  test('S5 SOS, kişi konuşabiliyor → ara (sahte CPaaS), öneri ulaşıldı + kişi iyi → kapat', async ({ page }) => {
    const before = await rowIds(page);
    const person = `pp_pw_s5_${Date.now()}`;
    const admin = process.env.ADMIN_TOKEN;
    if (admin) {
      const r = await page.request.put(`/v1/protected-persons/${person}/contacts`, {
        headers: { 'x-admin-token': admin },
        data: [{ role: 'WATCH', phone: '+905550000007' }],
      });
      expect(r.status()).toBe(200);
    }
    await sendSignal(page, 'SOS', person);
    const id = await claimNew(page, before);
    await page.keyboard.press('a');
    await expect(page.locator('.step.current')).toContainText('Aranıyor');
    if (admin) {
      const line = page.locator('.call-line');
      await expect(line).toContainText('Görüşme bitti', { timeout: 30_000 });
      await expect(line).toContainText('Kayıt alındı', { timeout: 15_000 });
      await expect(line.getByRole('button', { name: /Öneri: Ulaşıldı/ })).toBeVisible();
    }
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
  test('T-040 kişi kartı: tıbbi özet yalnız olay üstlenilince, adres ve kapı notuyla görünür', async ({ page }) => {
    const admin = process.env.ADMIN_TOKEN;
    test.skip(!admin, 'ADMIN_TOKEN gerekli (kişi profili yönetici ucuyla yüklenir)');
    const headers = { 'x-admin-token': admin! };
    const created = await page.request.post('/v1/protected-persons', {
      headers,
      data: {
        displayName: 'Ayşe Yılmaz',
        birthYear: 1945,
        address: { line: 'Bağdat Cd. No:1', district: 'Kadıköy', city: 'İstanbul', lat: 40.96, lng: 29.06 },
        doorAccessNote: 'Anahtar saksıda',
      },
    });
    expect(created.status()).toBe(201);
    const person = (await created.json()).id as string;
    const med = await page.request.put(`/v1/protected-persons/${person}/medical`, {
      headers,
      data: {
        consentAt: new Date(Date.now() - 60_000).toISOString(),
        conditions: ['Hipertansiyon'],
        medications: ['Metformin 1000 mg'],
        allergies: ['Penisilin'],
        bloodType: 'A+',
      },
    });
    expect(med.status()).toBe(200);

    const before = await rowIds(page);
    await sendSignal(page, 'SOS', person);
    const id = await newEvent(page, before);
    await page.locator(`.queue-row[data-event-id="${id}"]`).click();
    const panel = page.locator('aside.person');
    await expect(panel).toContainText('Tıbbi özet olayı üstlenince görünür.');
    await expect(panel).not.toContainText('Penisilin');
    await page.locator('main').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Enter');
    await expect(page.locator('.state')).toHaveText('Üstlenildi');
    const medical = panel.getByTestId('medical');
    await expect(medical).toContainText('Penisilin');
    await expect(medical).toContainText('Metformin 1000 mg');
    await expect(medical).toContainText('A+');
    await expect(panel).toContainText('Bağdat Cd. No:1, Kadıköy, İstanbul');
    await expect(panel).toContainText('Anahtar saksıda');
    await closeWith(page, 'Yanlış alarm');
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

test('T-051 telefon barı (eğitim modu): sahte cihaz, Ara → görüşme, beklet, aile ekle, bitir', async ({ page }) => {
  const apiCalls: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/v1')) apiCalls.push(r.url());
  });
  await page.goto('/?training=1');
  const bar = page.getByRole('contentinfo', { name: 'Telefon' });
  await expect(bar.getByTestId('phone-device')).toHaveText('Sahte telefon (gerçek arama yok)');
  await expect(bar.getByTestId('phone-call')).toHaveText('Görüşme yok');
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Enter');
  await expect(page.locator('.state')).toHaveText('Üstlenildi');
  await page.keyboard.press('a');
  await expect(bar.getByRole('button', { name: 'Aramayı bitir' })).toBeEnabled();
  await expect(bar.getByRole('button', { name: 'Beklet' })).toBeEnabled({ timeout: 5000 });
  await expect(bar.locator('.phone-time')).toBeVisible();
  await bar.getByRole('button', { name: 'Beklet' }).click();
  await expect(bar).toContainText('Beklemede');
  await bar.getByRole('button', { name: 'Devam et' }).click();
  await expect(bar).not.toContainText('Beklemede');
  await bar.getByRole('button', { name: 'Aileyi ekle' }).click();
  await expect(bar).toContainText('Konferans: 1 yakın');
  await bar.getByRole('button', { name: 'Aramayı bitir' }).click();
  await expect(bar.getByTestId('phone-call')).toHaveText('Görüşme yok');
  await expect(page.locator('.call-line .suggest')).toContainText('Ulaşıldı');
  expect(apiCalls).toEqual([]);
});

test('T-052 112 adımı (eğitim modu): masa sabit hattı uyarısı, MANUEL etiketi, "Sabit hattan aradım"', async ({
  page,
}) => {
  await page.goto('/?training=1');
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Enter');
  await expect(page.locator('.state')).toHaveText('Üstlenildi');
  await page.keyboard.press('Control+1');
  await page.getByLabel('Gerekçe (zorunlu)').fill('tatbikat');
  await page.getByLabel('Gerekçe (zorunlu)').press('Enter');
  await expect(page.locator('.step.current')).toContainText("112'yi ara");
  await expect(page.locator('.step.current .badge-manual')).toHaveText('MANUEL');
  const desk = page.getByTestId('desk-112');
  await expect(desk).toContainText("112'yi masadaki sabit hattan arayın");
  await expect(desk).toContainText('sonucu girin');
  const done = page.getByRole('button', { name: /Sabit hattan aradım/ });
  await done.click();
  await expect(page.locator('.step.current .step-result')).toContainText('Aranıyor');
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('1'); // sonucu elle gir: ulaşıldı
  await expect(page.locator('.state')).toHaveText('112 yönlendirildi');
});

test('operatör durumu (eğitim modu): üst barda Müsait / Molada', async ({ page }) => {
  await page.goto('/?training=1');
  const group = page.getByRole('group', { name: 'Durumum' });
  await expect(group.getByRole('button', { name: 'Müsait' })).toHaveAttribute('aria-pressed', 'true');
  await group.getByRole('button', { name: 'Molada' }).click();
  await expect(group.getByRole('button', { name: 'Molada' })).toHaveAttribute('aria-pressed', 'true');
  await expect(group.getByRole('button', { name: 'Müsait' })).toHaveAttribute('aria-pressed', 'false');
});
