import { useEffect, useState } from 'react';

/**
 * Duyarlı düzen: masaüstü ≥ 1280 px (üç sütun, klavye), tablet 768–1279 px (iki sütun, kişi paneli çekmece),
 * telefon < 768 px (tek sütun, alt sekmeler, sabit eylem çubuğu). Saf eşik fonksiyonu test edilir.
 */
export type Viewport = 'desktop' | 'tablet' | 'phone';
export const TABLET_MIN = 768;
export const DESKTOP_MIN = 1280;

export const viewportOf = (width: number): Viewport =>
  width >= DESKTOP_MIN ? 'desktop' : width >= TABLET_MIN ? 'tablet' : 'phone';

export function useViewport(): Viewport {
  const read = () => viewportOf(typeof window === 'undefined' ? DESKTOP_MIN : window.innerWidth);
  const [v, setV] = useState<Viewport>(read);
  useEffect(() => {
    const on = () => setV(read());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return v;
}

/** Telefon görünümünde hangi bölme görünür. */
export type Pane = 'queue' | 'event' | 'person';
