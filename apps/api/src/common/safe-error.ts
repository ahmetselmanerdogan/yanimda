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

/** Yalnız tanımlayıcı biçimli değerler (sınıf adı, hata kodu, kısıt adı) yazılır; serbest metin asla. */
const IDENT = /^[A-Za-z0-9_.-]{1,63}$/;

/**
 * Kalıcı saklanacak hata özeti (event.outbox / outbox_dlq / outbox_side last_error): hata zincirindeki (cause, en çok
 * 3 halka) sınıf adları, Postgres/ağ hata kodu ve varsa kısıt adı (şema tanımlayıcısı). Mesaj ve sorgu parametreleri
 * ASLA yazılmaz: Drizzle "Failed query: … params: …" konum/sağlık değeri içerebilir.
 */
export function safeErrorDetail(e: unknown): string {
  if (e === null) return 'null';
  if (typeof e !== 'object' && typeof e !== 'function') return typeof e;
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; depth < 3 && cur !== null && typeof cur === 'object'; depth++) {
    const err = cur as { name?: unknown; code?: unknown; constraint?: unknown; cause?: unknown };
    const ctor = (cur as { constructor?: { name?: unknown } }).constructor?.name;
    // Sınıf adı (DrizzleQueryError, DatabaseError) `name`den bilgilendirici: ikisi de 'Error' olabilir.
    const cls = typeof ctor === 'string' && ctor !== 'Error' && ctor !== 'Object' ? ctor : err.name;
    let s = typeof cls === 'string' && IDENT.test(cls) ? cls : 'Error';
    const code = typeof err.code === 'string' || typeof err.code === 'number' ? String(err.code) : '';
    if (IDENT.test(code)) s += `(${code})`;
    if (typeof err.constraint === 'string' && IDENT.test(err.constraint)) s += ` constraint=${err.constraint}`;
    parts.push(s);
    cur = err.cause;
  }
  return parts.join(' <- ');
}
