/** `?training=1` ve üretim dışı (T-026). Eğitim kodu üretim derlemesine hiç girmez (App'te tembel yükleme). */
export function trainingRequested(search = window.location.search, prod = import.meta.env.PROD): boolean {
  return !prod && new URLSearchParams(search).get('training') === '1';
}
