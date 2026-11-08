/**
 * Log'a yazılabilir hata özeti. Sürücü hata mesajları (ör. Drizzle "Failed query ... params: ...") sorgu
 * parametrelerini — dolayısıyla konum/sağlık gibi PII'yi — içerebilir; bu yüzden mesaj DEĞİL, yalnız ad ve
 * Postgres/Redis hata kodu döner.
 */
export function safeError(e: unknown): string {
  const err = e as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  const code = err?.cause?.code ?? err?.code;
  const name = err?.cause?.name ?? err?.name ?? typeof e;
  return code ? `${name}(${code})` : String(name);
}
