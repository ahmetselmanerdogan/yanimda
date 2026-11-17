import { readFileSync } from 'node:fs';

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

// Görünen metinler katalogdan (packages/messages/tr.json): metin değişince test kendiliğinden uyar. JSON içe
// aktarma Playwright'ın ESM yükleyicisinde içe aktarma özniteliği ister; dosya doğrudan okunur.
const catalog = JSON.parse(
  readFileSync(new URL('../../../packages/messages/tr.json', import.meta.url), 'utf8'),
) as Record<string, { text: string }>;
const t = (code: string) => catalog[code]!.text;

/**
 * T-082 (04 kontrol listesi, web): aile kayıt sihirbazının her adımı ve diğer sayfalar axe ile taranır;
 * ciddi/kritik ihlal 0. Ayrıca klavyeyle gezinme ve 200% yakınlaştırmada yatay kaydırma yok (WCAG 1.4.10).
 */
const PLANS = {
  country: 'TR',
  trialDays: 30,
  kvkkNoticeVersion: 'v1',
  plans: [
    {
      code: 'STANDARD',
      interval: 'month',
      nameCode: 'F-WEB-PLAN-STANDARD',
      currency: 'TRY',
      amountMinor: 49900,
      placeholder: true,
    },
    {
      code: 'STANDARD_YEARLY',
      interval: 'year',
      nameCode: 'F-WEB-PLAN-STANDARD_YEARLY',
      currency: 'TRY',
      amountMinor: 499000,
      placeholder: true,
    },
  ],
};

async function mockApi(page: Page) {
  await page.route('**/v1/plans**', (r) => r.fulfill({ json: PLANS }));
  await page.route('**/v1/signup', (r) =>
    r.fulfill({
      status: 201,
      json: {
        subscriptionId: '01960000-0000-7000-8000-000000000001',
        protectedPersonId: '01960000-0000-7000-8000-000000000002',
        signupToken: 'test-token',
        signupTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        phoneVerification: 'SENT',
      },
    }),
  );
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test.beforeEach(async ({ page }) => mockApi(page));

test('kayıt: paket → hesap (hatalı gönderim dahil) → telefon kodu', async ({ page }) => {
  await page.goto('/kayit');
  await expect(page.getByRole('button', { name: t('F-WEB-CHOOSE') }).first()).toBeVisible();
  await axe(page);

  await page
    .getByRole('button', { name: t('F-WEB-CHOOSE') })
    .first()
    .click();
  await expect(page.getByLabel(t('F-WEB-FIRST-NAME'), { exact: true })).toBeVisible();
  await axe(page);
  // Boş gönderim: hata iletileri alanlara bağlı ve erişilebilir olmalı.
  await page.getByRole('button', { name: t('F-WEB-CREATE-ACCOUNT') }).click();
  // Onay kutuları da hatalı işaretlenir ve hata iletisine bağlanır (Field ile aynı).
  for (const cb of await page.getByRole('checkbox').all()) {
    await expect(cb).toHaveAttribute('aria-invalid', 'true');
    const err = page.locator(`#${await cb.getAttribute('aria-describedby')}`);
    await expect(err).toHaveAttribute('role', 'alert');
  }
  await axe(page);

  await page.getByLabel(t('F-WEB-FIRST-NAME'), { exact: true }).fill('Ayşe');
  await page.getByLabel(t('F-WEB-LAST-NAME')).fill('Yılmaz');
  await page.getByLabel(t('F-WEB-EMAIL')).fill('aile@example.com');
  await page.getByLabel(t('F-WEB-PHONE')).fill('05551112233');
  await page.getByLabel(t('F-WEB-ELDER-NAME')).fill('Fatma');
  for (const cb of await page.getByRole('checkbox').all()) await cb.check();
  await page.getByRole('button', { name: t('F-WEB-CREATE-ACCOUNT') }).click();
  await expect(page.getByLabel(t('F-WEB-PHONE-CODE'))).toBeVisible();
  // WCAG 2.4.3: adım değişince odak yeni adımın başlığında.
  await expect(page.getByRole('heading', { name: t('F-WEB-PHONE'), level: 2 })).toBeFocused();
  await axe(page);
});

test('klavye: paket seçimi ve form yalnız klavyeyle tamamlanabilir; odak görünür', async ({ page }) => {
  await page.goto('/kayit');
  const choose = page.getByRole('button', { name: t('F-WEB-CHOOSE') }).first();
  await expect(choose).toBeVisible();
  for (let i = 0; i < 20 && !(await choose.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press('Tab');
  await expect(choose).toBeFocused();
  const outline = await choose.evaluate((el) => getComputedStyle(el).outlineStyle + getComputedStyle(el).boxShadow);
  expect(outline).not.toBe('nonenone');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel(t('F-WEB-FIRST-NAME'), { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: t('F-WEB-ACCOUNT'), level: 2 })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel(t('F-WEB-FIRST-NAME'), { exact: true })).toBeFocused();
});

test('KVKK ve hesabım sayfaları', async ({ page }) => {
  await page.goto('/kvkk');
  await axe(page);
  await page.goto('/hesap');
  await axe(page);
  await page.goto('/hesap/davet');
  await expect(page.getByRole('heading', { name: t('F-WEB-MEMBERS-ACCEPT-TITLE') })).toBeVisible();
  await axe(page);
});

test('200% yakınlaştırma (320 px genişlik) yatay kaydırma yok', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/kayit');
  await expect(page.getByRole('button', { name: t('F-WEB-CHOOSE') }).first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
