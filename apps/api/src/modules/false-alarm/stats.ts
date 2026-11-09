import type { FalseAlarmCause } from '@yanimda/contracts';
import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client';

export interface FalseAlarmStats {
  windowDays: number;
  /** Pencerede kapanan (test hariç) olay sayısı. */
  closedEvents: number;
  /** Pencerede kaydedilen yanlış alarm sayısı (olay başına bir). */
  falseAlarms: number;
  /** falseAlarms / closedEvents (0–1; olay yoksa 0). */
  ratio: number;
  byCause: Record<FalseAlarmCause, number>;
  /** Pencerede eşiğe (reviewAfter) ulaşan kişi sayısı (kişi ucunda 0/1). */
  repeatPersons: number;
}

type Rows<T> = { rows: T[] };

/**
 * T-071 yanlış alarm oranı: `windowDays` günde event.false_alarm kayıtları / kapanan gerçek olaylar. personId
 * verilirse yalnız o kişi (aile ucu), verilmezse tümü (amir panosu, E-11).
 */
export async function falseAlarmStats(
  db: Pick<Db, 'execute'>,
  now: Date,
  windowDays: number,
  reviewAfter: number,
  personId?: string,
): Promise<FalseAlarmStats> {
  const since = new Date(now.getTime() - windowDays * 86_400_000);
  const forEvent = personId ? sql`AND protected_person_id = ${personId}` : sql``;
  const rows = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as Rows<T>).rows;
  const [closed] = await rows<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM event.event
    WHERE closed_at > ${since} AND closed_at <= ${now} AND NOT is_test ${forEvent}`);
  const causes = await rows<{ cause: FalseAlarmCause; n: number }>(sql`
    SELECT cause, count(*)::int AS n FROM event.false_alarm
    WHERE at > ${since} AND at <= ${now} ${forEvent} GROUP BY cause`);
  const [repeat] = await rows<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM (
      SELECT protected_person_id FROM event.false_alarm
      WHERE at > ${since} AND at <= ${now} ${forEvent}
      GROUP BY protected_person_id HAVING count(*) >= ${reviewAfter}) x`);
  const byCause: Record<FalseAlarmCause, number> = { USER_CANCEL: 0, OPERATOR: 0, FAMILY_FEEDBACK: 0 };
  for (const c of causes) byCause[c.cause] = c.n;
  const falseAlarms = causes.reduce((a, c) => a + c.n, 0);
  const closedEvents = closed?.n ?? 0;
  return {
    windowDays,
    closedEvents,
    falseAlarms,
    ratio: closedEvents ? Math.min(1, falseAlarms / closedEvents) : 0,
    byCause,
    repeatPersons: repeat?.n ?? 0,
  };
}
