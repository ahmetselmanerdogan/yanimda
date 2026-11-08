import { type DeviceAdapter, type DeviceKind, UnsupportedSignalError } from './device.types';

/** Cihaz türü → adaptör. Kayıtsız cihaz (tür null) → SIMULATOR adaptörü (o da üretimde reddeder). */
export class AdapterRegistry {
  private readonly byKind = new Map<string, DeviceAdapter>();

  constructor(adapters: DeviceAdapter[]) {
    for (const a of adapters) {
      if (this.byKind.has(a.kind)) throw new Error(`Adaptör iki kez kaydedildi: ${a.kind}`);
      this.byKind.set(a.kind, a);
    }
  }

  for(kind: string | null): DeviceAdapter {
    const a = this.byKind.get(kind ?? 'SIMULATOR');
    if (!a) throw new UnsupportedSignalError(`Bilinmeyen cihaz türü: ${kind}`);
    return a;
  }

  kinds(): DeviceKind[] {
    return [...this.byKind.keys()] as DeviceKind[];
  }
}
