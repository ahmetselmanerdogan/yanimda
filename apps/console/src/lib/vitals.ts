import type { EventVitalsView, VitalQuality, VitalRule } from '@yanimda/contracts';

/**
 * T-092 (docs/07 S6.8, S7.1) olay ekranındaki değer grafiği — saf yardımcılar (lib/vitals.test.ts). Sunucu yalnız 5 dk
 * ortancaları verir; grafik düz SVG (yeni bağımlılık yok).
 */
export const qualityCode = (q: VitalQuality) => `O-UI-VITALS-QUALITY-${q}`;
export const ruleCode = (r: VitalRule) => `O-UI-VITAL-RULE-${r}`;
export const seriesCode = (k: 'HR' | 'SPO2') => (k === 'HR' ? 'O-UI-VITALS-HR' : 'O-UI-VITALS-SPO2');

export interface ChartGeometry {
  /** SVG çizgi yolu ("M x y L x y …"); tek nokta için kısa yatay çizgi. */
  path: string;
  /** Noktaların koordinatları (ekran okuyucu özeti ve işaretler için). */
  dots: { x: number; y: number; value: number }[];
  /** Taban çizgisinin y'si (alan dışındaysa kenara kırpılır); taban yoksa null. */
  baselineY: number | null;
  min: number;
  max: number;
}

/**
 * Noktaları [from, from + windowMin] zaman ekseni ve değer aralığına (taban dahil, %10 pay) yerleştirir. Değer ekseni
 * yukarı doğru artar (SVG'de y aşağı).
 */
export function chartGeometry(
  points: { at: string; value: number }[],
  opts: { width: number; height: number; from: number; windowMin: number; baseline?: number | null; pad?: number },
): ChartGeometry {
  const pad = opts.pad ?? 4;
  const values = points.map((p) => p.value);
  const all = opts.baseline != null ? [...values, opts.baseline] : values;
  const lo = all.length ? Math.min(...all) : 0;
  const hi = all.length ? Math.max(...all) : 1;
  const span = hi - lo || Math.max(1, Math.abs(hi) * 0.1);
  const min = lo - span * 0.1;
  const max = hi + span * 0.1;
  const w = opts.width - 2 * pad;
  const h = opts.height - 2 * pad;
  const total = opts.windowMin * 60_000;
  const x = (at: string) => pad + Math.min(1, Math.max(0, (Date.parse(at) - opts.from) / total)) * w;
  const y = (v: number) => pad + (1 - (Math.min(max, Math.max(min, v)) - min) / (max - min)) * h;
  const dots = points.map((p) => ({ x: round(x(p.at)), y: round(y(p.value)), value: p.value }));
  const path =
    dots.length === 1
      ? `M ${round(dots[0]!.x - 3)} ${dots[0]!.y} L ${round(dots[0]!.x + 3)} ${dots[0]!.y}`
      : dots.map((d, i) => `${i ? 'L' : 'M'} ${d.x} ${d.y}`).join(' ');
  return {
    path,
    dots,
    baselineY: opts.baseline != null ? round(y(opts.baseline)) : null,
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
  };
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Nabız için gösterilecek taban: dinlenme, yoksa uyku (S6.3 dilimleri). */
export const hrBaseline = (v: Pick<EventVitalsView, 'baseline'>): number | null =>
  v.baseline?.HR.REST ?? v.baseline?.HR.SLEEP ?? null;
