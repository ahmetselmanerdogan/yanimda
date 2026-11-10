import type { CheckoutSession } from './api';

/**
 * Sağlayıcı sayfasını aç: yönlendirme (Stripe, sahte) veya iyzico Checkout Form içeriği (script) — innerHTML ile
 * eklenen script çalışmadığından script öğeleri yeniden oluşturulur.
 */
export function openCheckout(s: CheckoutSession, container: HTMLElement | null) {
  if (s.kind === 'redirect') {
    window.location.assign(s.url);
    return;
  }
  if (!container) return;
  const tpl = document.createElement('template');
  tpl.innerHTML = s.html;
  container.replaceChildren();
  for (const node of Array.from(tpl.content.childNodes)) {
    if (node instanceof HTMLScriptElement) {
      const sc = document.createElement('script');
      for (const a of Array.from(node.attributes)) sc.setAttribute(a.name, a.value);
      sc.text = node.text;
      document.body.appendChild(sc);
    } else container.appendChild(node.cloneNode(true));
  }
}
