/** T-040 adres doğrulama: adres → lat/lng. Adres kişisel veridir; log'a yazılmaz. */
export interface Geocoder {
  geocode(address: string, country: string): Promise<{ lat: number; lng: number } | null>;
}

export const GEOCODER = Symbol('GEOCODER');

/** Google Geocoding API (GOOGLE_GEOCODING_KEY). Sonuç yoksa / hata olursa null (kayıt engellenmez). */
export class GoogleGeocoder implements Geocoder {
  constructor(
    private readonly key: string,
    private readonly http: typeof fetch = fetch,
  ) {}

  async geocode(address: string, country: string) {
    const u = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    u.searchParams.set('address', address);
    u.searchParams.set('components', `country:${country}`);
    u.searchParams.set('language', 'tr');
    u.searchParams.set('key', this.key);
    // Adres sorgu dizesinde: yalnız Google'a, TLS ile; sunucu log'una URL yazılmaz.
    const r = await this.http(u, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return null;
    const body = (await r.json()) as {
      status: string;
      results?: { geometry: { location: { lat: number; lng: number } } }[];
    };
    const loc = body.status === 'OK' ? body.results?.[0]?.geometry.location : undefined;
    return loc ? { lat: loc.lat, lng: loc.lng } : null;
  }
}

export function geocoderFromEnv(env: NodeJS.ProcessEnv = process.env): Geocoder | null {
  return env.GOOGLE_GEOCODING_KEY ? new GoogleGeocoder(env.GOOGLE_GEOCODING_KEY) : null;
}
