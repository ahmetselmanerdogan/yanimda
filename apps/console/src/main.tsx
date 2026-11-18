import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { BootConfigError, BootGate, bootGateCode } from './BootGate';
import { loadRuntimeConfig, runtimeConfigProblem } from './lib/config';
import { applyTheme } from './lib/theme';

applyTheme();
// PWA: üretimde service worker (uygulama kabuğu; API asla önbelleğe alınmaz). Eğitim / geliştirme modunda yok.
if (import.meta.env.PROD && 'serviceWorker' in navigator)
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined));
// Tek imaj, ortam başına /config.json (Caddy ortamdan üretir): uygulama ve OIDC istemcisi yapılandırma okunduktan
// sonra yüklenir (lib/auth.ts UserManager'ı modül yüklenirken kurar).
// Üst düzey await yok (Vite varsayılan derleme hedefi desteklemez): zincirle. Yapılandırma üretimde eksikse veya
// uygulama parçası yüklenemezse (yayından sonra eski sekme → parça 404) boş sayfa yerine yenile kapısı.
const root = createRoot(document.getElementById('root')!);
void loadRuntimeConfig()
  .then(() => {
    if (runtimeConfigProblem()) throw new BootConfigError();
    return import('./App');
  })
  .then(({ App }) =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  )
  .catch((e: unknown) => {
    console.error('Konsol açılamadı', e);
    root.render(<BootGate code={bootGateCode(e)} />);
  });
