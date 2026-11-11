import { ApiError } from './api';
import { has } from './i18n';

/**
 * T-040 aile üyeleri (C-02, C-04) saf yardımcıları (birim testli): davet kodu biçimi, API hatası → katalog kodu,
 * satır başına hangi eylem (çıkar / ayrıl) gösterilir.
 */
export type MemberRole = 'OWNER' | 'MEMBER';
export interface MemberView {
  id: string;
  role: MemberRole;
  relation: string | null;
  createdAt: string;
  isMe: boolean;
}

const CODE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/** API ile aynı kural: büyük harf, boşluk/tire yok, O→0, I/L→1. Geçersizse null. Gönderimde `XXXXX-XXXXX`. */
export function normalizeMemberCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE.test(s) ? `${s.slice(0, 5)}-${s.slice(5)}` : null;
}

/** API hatası → katalog kodu. Sunucu katalog kodu verdiyse (problem+json `code`) o; yoksa duruma göre. */
export function memberErrorCode(e: unknown, step: 'accept' | 'invite' | 'remove' | 'list'): string {
  if (!(e instanceof ApiError)) return 'F-WEB-ERROR';
  if (e.code && has(e.code)) return e.code;
  if (e.status === 429) return 'F-WEB-ERROR-TOO-MANY';
  if (step === 'accept' && e.status === 400) return 'F-MEMBER-CODE-INVALID';
  if (step === 'accept' && e.status === 409) return 'F-MEMBER-ALREADY';
  if (e.status === 403) return 'F-MEMBER-OWNER-ONLY';
  return 'F-WEB-ERROR';
}

/** Davet kodunun son geçerlilik anı (72 saat: gün yetmez, saat de gösterilir). */
export function formatDateTime(iso: string, locale = 'tr-TR'): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(iso));
}

/** Rol etiketi (katalog kodu). */
export const roleCode = (m: Pick<MemberView, 'role'>) =>
  m.role === 'OWNER' ? 'F-WEB-MEMBERS-ROLE-OWNER' : 'F-WEB-MEMBERS-ROLE-MEMBER';

/**
 * Satırdaki eylem: kendi satırı → "ayrıl" (son sahip ayrılamaz); sahip başkasını → "çıkar" (son sahip hariç);
 * üye başkasını → yok. Sunucu aynı kuralı uygular; düğme yalnız işe yarayacaksa gösterilir.
 */
export function memberAction(m: MemberView, all: MemberView[], myRole: MemberRole | null): 'remove' | 'leave' | null {
  const owners = all.filter((x) => x.role === 'OWNER').length;
  if (m.role === 'OWNER' && owners <= 1) return null; // son hesap sahibi

  if (m.isMe) return 'leave';
  return myRole === 'OWNER' ? 'remove' : null;
}
