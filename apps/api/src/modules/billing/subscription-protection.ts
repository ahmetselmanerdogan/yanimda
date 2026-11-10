import { eq, sql } from 'drizzle-orm';

import type { Db } from '../../db/client';
import { subscription } from '../../db/schema';
import { effective, type SubscriptionFacts, type SubscriptionStatus } from './lifecycle';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Row = typeof subscription.$inferSelect;

export const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
export const factsOf = (r: Row): SubscriptionFacts => ({
  status: r.status as SubscriptionStatus,
  startedAt: r.startedAt,
  trialEndsAt: r.trialEndsAt,
  pastDueSince: r.pastDueSince,
  graceUntil: r.graceUntil,
  suspendedAt: r.suspendedAt,
  renewsAt: r.renewsAt,
  lastProviderEventAt: r.lastProviderEventAt,
});

/** Kişinin açık aboneliği ve koruma etkisi (cihaz config, T-041). Abonelik yoksa koruma açık (kurumsal kişi). */
export async function subscriptionProtection(db: Pick<Db, 'select'>, protectedPersonId: string, now = new Date()) {
  const [r] = UUID.test(protectedPersonId)
    ? await db
        .select()
        .from(subscription)
        .where(eq(subscription.protectedPersonId, protectedPersonId))
        .orderBy(sql`${subscription.status} = 'CANCELED', ${subscription.startedAt} DESC`)
        .limit(1)
    : [];
  const e = effective(r ? factsOf(r) : null, now);
  return { status: e.status, protectionActive: e.protectionActive, until: iso(e.until) };
}
