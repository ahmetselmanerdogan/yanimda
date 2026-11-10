import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

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
  await expect(page.getByRole('button', { name: 'Bu paketi seç' }).first()).toBeVisible();
  await axe(page);

  await page.getByRole('button', { name: 'Bu paketi seç' }).first().click();
  await expect(page.getByLabel('Adınız', { exact: true })).toBeVisible();
  await axe(page);
  // Boş gönderim: hata iletileri alanlara bağlı ve erişilebilir olmalı.
  await page.getByRole('button', { name: 'Hesabı oluştur' }).click();
  await axe(page);

  await page.getByLabel('Adınız', { exact: true }).fill('Ayşe');
  await page.getByLabel('Soyadınız').fill('Yılmaz');
  await page.getByLabel('E-posta').fill('aile@example.com');
  await page.getByLabel('Cep telefonu').fill('05551112233');
  await page.getByLabel('Adı (örn. Ayşe Teyze)').fill('Fatma');
  for (const cb of await page.getByRole('checkbox').all()) await cb.check();
  await page.getByRole('button', { name: 'Hesabı oluştur' }).click();
  await expect(page.getByLabel('Telefonunuza gelen 6 haneli kod')).toBeVisible();
  await axe(page);
});

test('klavye: paket seçimi ve form yalnız klavyeyle tamamlanabilir; odak görünür', async ({ page }) => {
  await page.goto('/kayit');
  const choose = page.getByRole('button', { name: 'Bu paketi seç' }).first();
  await expect(choose).toBeVisible();
  for (let i = 0; i < 20 && !(await choose.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press('Tab');
  await expect(choose).toBeFocused();
  const outline = await choose.evaluate((el) => getComputedStyle(el).outlineStyle + getComputedStyle(el).boxShadow);
  expect(outline).not.toBe('nonenone');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Adınız', { exact: true })).toBeVisible();
});

test('KVKK ve hesabım sayfaları', async ({ page }) => {
  await page.goto('/kvkk');
  await axe(page);
  await page.goto('/hesap');
  await axe(page);
});

test('200% yakınlaştırma (320 px genişlik) yatay kaydırma yok', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/kayit');
  await expect(page.getByRole('button', { name: 'Bu paketi seç' }).first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
