import type { EventRecord, QueueItem } from './api';

/** E-09 / T-025 SLA hedefleri (sn): kuyruğa düşünce üstlenme 10, üstlenince ilk arama 20. */
export const CLAIM_SLA_SEC = 10;
export const FIRST_CALL_SLA_SEC = 20;

const sec = (from: string | undefined | null, now: number) => (from ? (now - Date.parse(from)) / 1000 : 0);

export interface Sla {
  ageSec: number;
  /** Bekleyen olay için üstlenmeye kalan (negatif = aşıldı); üstlenilmişse undefined. */
  claimLeftSec?: number;
  /** Üstlenilmiş, henüz aranmamış olay için ilk aramaya kalan. */
  firstCallLeftSec?: number;
}

export function slaOf(
  item: Pick<QueueItem, 'createdAt' | 'escalatedAt' | 'state'>,
  ev: EventRecord | null,
  firstCalledAt: string | undefined,
  now: number,
): Sla {
  const s: Sla = { ageSec: sec(item.createdAt, now) };
  if (item.state === 'OPERATOR_QUEUE') s.claimLeftSec = CLAIM_SLA_SEC - sec(item.escalatedAt ?? item.createdAt, now);
  if (ev && !firstCalledAt && (ev.state === 'OPERATOR_ASSIGNED' || ev.state === 'CONTACT_CHAIN')) {
    const assigned = [...ev.transitions].reverse().find((x) => x.to === 'OPERATOR_ASSIGNED')?.at;
    if (assigned) s.firstCallLeftSec = FIRST_CALL_SLA_SEC - sec(assigned, now);
  }
  return s;
}

/** 75 sn → "1:15"; negatif değer için başta "−". */
export function clock(totalSec: number): string {
  const neg = totalSec < 0;
  const v = Math.floor(Math.abs(totalSec));
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = String(v % 60).padStart(2, '0');
  const body = h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  return neg ? `−${body}` : body;
}
