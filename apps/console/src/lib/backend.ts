import { type Api, createApi, queueSocketUrl } from './api';
import { currentToken, userManager } from './auth';
import { type LiveHandlers, QueueSocket } from './live';

/** Konsolun arka ucu: REST + canlı kuyruk. Gerçek API veya eğitim modu (yerel, sahte olaylar). */
export interface Backend {
  api: Api;
  /** Canlı kuyruğa bağlan; dönen fonksiyon bağlantıyı kapatır. */
  connect(h: LiveHandlers): () => void;
}

export function realBackend(): Backend {
  return {
    api: createApi(currentToken),
    connect(h) {
      const sock = new QueueSocket(queueSocketUrl(), currentToken, h);
      sock.start();
      const renewed = () => void sock.reauth(); // yenilenen token WS'ye
      userManager.events.addUserLoaded(renewed);
      return () => {
        userManager.events.removeUserLoaded(renewed);
        sock.stop();
      };
    },
  };
}
