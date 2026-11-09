import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { login, newEvent, rowIds, sendSignal } from './support';

/**
 * T-023 kabulü: giriş → simülatör olayı → Enter → adım 1 "cevap yok" → adım 2 açılır → C ile kapat → kuyruktan
 * düşer; erişilebilirlik: axe ciddi hata 0.
 */
test('konsol: üstlen, cevap yok, kapat', async ({ page }) => {
  await login(page);
  const before = await rowIds(page);
  await sendSignal(page, 'SOS');
  const id = await newEvent(page, before);
  const row = page.locator(`.queue-row[data-event-id="${id}"]`);

  await row.click();
  await page.locator('main').click({ position: { x: 5, y: 5 } }); // odak düğmede kalmasın
  await page.keyboard.press('Enter');
  await expect(page.locator('.state')).toHaveText('Üstlenildi');
  await expect(page.locator('.step.current .step-n')).toHaveText('1');

  await page.keyboard.press('2');
  await expect(page.locator('.step').first()).toContainText('Cevap yok');
  await expect(page.locator('.step.current .step-n')).toHaveText('2');
  await expect(page.locator('.state')).toHaveText('Aranıyor');

  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'Olayı kapat' });
  await dialog.getByLabel('Ulaşılamadı').check();
  await dialog.getByRole('button', { name: 'Kapat' }).click();
  await expect(row).toHaveCount(0);
});

test('konsol: erişilebilirlik (axe) ciddi/kritik hata yok', async ({ page }) => {
  await login(page);
  const before = await rowIds(page);
  await sendSignal(page, 'SOS');
  const id = await newEvent(page, before);
  await page.locator(`.queue-row[data-event-id="${id}"]`).click();
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Enter');
  await expect(page.locator('.step.current')).toBeVisible();

  const r = await new AxeBuilder({ page }).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
});
