import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { loadRuntimeConfig } from './lib/config';
import { applyTheme } from './lib/theme';

applyTheme();
// PWA: üretimde service worker (uygulama kabuğu; API asla önbelleğe alınmaz). Eğitim / geliştirme modunda yok.
if (import.meta.env.PROD && 'serviceWorker' in navigator)
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined));
// Tek imaj, ortam başına /config.json (Caddy ortamdan üretir): uygulama ve OIDC istemcisi yapılandırma okunduktan
// sonra yüklenir (lib/auth.ts UserManager'ı modül yüklenirken kurar).
// Üst düzey await yok (Vite varsayılan derleme hedefi desteklemez): zincirle.
void loadRuntimeConfig()
  .then(() => import('./App'))
  .then(({ App }) =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  );
