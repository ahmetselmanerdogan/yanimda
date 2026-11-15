#!/usr/bin/env node
/* eslint-disable no-console -- komut satırı betiği */
/**
 * Var olan geliştirme Keycloak'ına realm dosyalarında sonradan eklenen istemci ve rolleri ekler.
 * `--import-realm` realm varsa hiçbir şey yapmaz; bu yüzden eski bir konteynerde örneğin `family-web` istemcisi
 * (T-060) bulunmaz ve aile web girişi "istemci bulunamadı" der. Var olan istemci/rol DEĞİŞTİRİLMEZ (SKIP);
 * politika değişiklikleri için README "Keycloak (T-081)" bölümüne bakın. Üretimde kullanılmaz.
 *
 *   KEYCLOAK_URL=http://localhost:8080 node infra/keycloak/sync-realms.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REALMS = ['operations', 'consumers'];

/** Keycloak içe aktarmasındaki `${AD:varsayılan}` çözümünün aynısı: ortamda varsa o, yoksa varsayılan. */
export const resolvePlaceholders = (text, env = process.env) =>
  text.replace(/\$\{([A-Z0-9_]+):([^}]*)\}/g, (_, name, def) => env[name] ?? def);

/** partialImport gövdesi: realm dosyasındaki istemciler ve realm rolleri, var olanlar atlanır. */
export function syncBody(realmName, env = process.env) {
  const realm = JSON.parse(resolvePlaceholders(readFileSync(join(here, `realm-${realmName}.json`), 'utf8'), env));
  return { ifResourceExists: 'SKIP', clients: realm.clients ?? [], roles: { realm: realm.roles?.realm ?? [] } };
}

async function main() {
  const kc = (process.env.KEYCLOAK_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  const t = await fetch(`${kc}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: process.env.KEYCLOAK_ADMIN_USER ?? 'admin',
      password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin',
    }),
  });
  if (!t.ok) throw new Error(`Keycloak yönetici girişi başarısız: HTTP ${t.status}`);
  const token = (await t.json()).access_token;
  for (const name of REALMS) {
    const r = await fetch(`${kc}/admin/realms/${name}/partialImport`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(syncBody(name)),
    });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${await r.text()}`);
    const j = await r.json();
    const added = (j.results ?? [])
      .filter((x) => x.action === 'ADDED')
      .map((x) => `${x.resourceType}:${x.resourceName}`);
    console.log(
      `${name}: ${j.added ?? 0} eklendi, ${j.skipped ?? 0} zaten vardı${added.length ? ` (${added.join(', ')})` : ''}`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
