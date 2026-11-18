import { action, t } from './lib/i18n';

/** Açılış kapısının nedeni: uygulama parçası yüklenemedi (yayın sonrası eski sayfa) veya üretim yapılandırması eksik. */
export type BootGateCode = 'O-UI-RELOAD' | 'O-UI-CONFIG-MISSING';

/**
 * Açılış başarısız olduğunda boş sayfa yerine gösterilen en küçük ekran. App'e ve OIDC'ye bağımlı değildir
 * (yalnız katalog metni ve styles.css `.gate`): parça (chunk) 404'ü veya bozuk yapılandırmada da çizilir.
 */
export function BootGate({ code, reload }: { code: BootGateCode; reload?: () => void }) {
  return (
    <main className="gate" role="alert">
      <h1>{t('O-UI-TITLE')}</h1>
      <p>{t(code)}</p>
      <button type="button" className="primary" onClick={reload ?? (() => window.location.reload())}>
        {action('O-UI-RELOAD')}
      </button>
    </main>
  );
}

/** Açılış hatasının kapı metni: yapılandırma hatası ayrı, diğer her şey (parça 404, ağ) "yenileyin". */
export class BootConfigError extends Error {
  constructor() {
    super('O-UI-CONFIG-MISSING');
    this.name = 'BootConfigError';
  }
}
export const bootGateCode = (e: unknown): BootGateCode =>
  e instanceof BootConfigError ? 'O-UI-CONFIG-MISSING' : 'O-UI-RELOAD';
