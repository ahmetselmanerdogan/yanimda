/** E-09 SLA hedefleri (sn): kuyruğa düşüşten üstlenmeye, üstlenmeden ilk aramaya. Konsol sayaçlarıyla aynı. */
export const CLAIM_SLA_SEC = 10;
export const FIRST_CALL_SLA_SEC = 20;
/**
 * Gece karar listesi 2: üstlenme hedefi önceliğe göre (P1 hayati 10 sn; P4 düzenli/geri arama 10 dk). Konsol
 * (apps/console/src/lib/sla.ts) aynı tabloyu kullanır.
 */
export const CLAIM_SLA_BY_PRIORITY: Record<number, number> = { 1: 10, 2: 30, 3: 120, 4: 600 };
export const claimSlaSec = (priority: number) => CLAIM_SLA_BY_PRIORITY[priority] ?? CLAIM_SLA_SEC;
