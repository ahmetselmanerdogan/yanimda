import { createHmac } from 'node:crypto';

import { expect, type Page } from '@playwright/test';

/** Keycloak TOTP (HmacSHA1, 6 hane, 30 sn). Sır Keycloak'ın sakladığı düz metin (dev-users.mjs). */
export function totp(secret: string, at = Date.now()): string {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', Buffer.from(secret)).update(c).digest();
  const o = h[19]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} gerekli`);
  return v;
};

export const AUTH_STATE = 'test-results/.auth/operator.json';

/**
 * Konsola gerçek Keycloak akışıyla gir. Keycloak oturumu (SSO çerezi) global kurulumda bir kez açılır; testler
 * yalnız "Giriş yap" ile döner. Oturum yoksa kullanıcı adı/parola ve OTP girilir (aynı OTP iki kez kullanılamaz).
 */
export async function login(page: Page, username = 'operator1') {
  await page.goto('/');
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  const form = page.locator('#username');
  const live = page.getByRole('status');
  await expect(form.or(live)).toBeVisible({ timeout: 15_000 });
  if (await live.isVisible()) return expect(live).toHaveText('Canlı', { timeout: 15_000 });
  await form.fill(username);
  await page.locator('#password').fill(env('KEYCLOAK_DEV_PASSWORD'));
  await page.locator('#kc-login').click();
  // Aynı kod iki kez kullanılamaz: pencerenin son 3 sn'sindeysek bir sonrakini bekle.
  if (Date.now() % 30_000 > 27_000) await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 200);
  await page.locator('#otp').fill(totp(env('KEYCLOAK_DEV_OTP_SECRET')));
  await page.locator('#kc-login').click();
  await expect(page.getByRole('status')).toHaveText('Canlı', { timeout: 15_000 });
}

/** Simülatör gibi sinyal gönder (aynı köken /v1 proxy'si; API simülatör modunda token'sız sinyal kabul eder). */
export async function sendSignal(page: Page, kind: string, person = `pp_pw_${Date.now()}`) {
  const r = await page.request.post('/v1/signals', {
    data: [
      {
        schemaVersion: 1,
        idempotencyKey: `pw:${person}:${kind}:${Date.now()}`,
        deviceId: `sim-${person}`,
        protectedPersonId: person,
        kind,
        occurredAt: new Date().toISOString(),
      },
    ],
  });
  expect(r.status()).toBe(202);
  return person;
}

export const rowIds = (page: Page) =>
  page.locator('.queue-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-event-id')!));

/** Sinyalden sonra kuyrukta yeni beliren olay. */
export async function newEvent(page: Page, before: string[]) {
  let id: string | undefined;
  await expect
    .poll(async () => {
      id = (await rowIds(page)).find((x) => !before.includes(x));
      return id;
    })
    .toBeTruthy();
  return id!;
}
