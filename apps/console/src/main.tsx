import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { applyTheme } from './lib/theme';

applyTheme();
// PWA: üretimde service worker (uygulama kabuğu; API asla önbelleğe alınmaz). Eğitim / geliştirme modunda yok.
if (import.meta.env.PROD && 'serviceWorker' in navigator)
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined));
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
