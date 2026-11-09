import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { chromium, type FullConfig } from '@playwright/test';

import { AUTH_STATE, login } from './support';

/** Keycloak'a bir kez gir (parola + OTP), SSO çerezini sakla; testler bu oturumla açılır. */
export default async function globalSetup(config: FullConfig) {
  const use = config.projects[0]!.use;
  const browser = await chromium.launch({ channel: use.channel });
  const page = await browser.newPage({ baseURL: use.baseURL });
  await login(page);
  mkdirSync(dirname(AUTH_STATE), { recursive: true });
  await page.context().storageState({ path: AUTH_STATE });
  await browser.close();
}
