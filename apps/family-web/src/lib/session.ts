import type { Country } from './flow';

/** Kayıt akışının tarayıcı oturumu (sessionStorage; sekme kapanınca silinir). Kişisel veri tutulmaz. */
export interface SignupSession {
  subscriptionId: string;
  protectedPersonId: string;
  token: string;
  trialEndsAt: string;
  country: Country;
  phoneVerified: boolean;
}

const KEY = 'yanimda.signup';

export function loadSession(): SignupSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SignupSession) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: SignupSession) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* gizli sekme: akış yine çalışır, yalnız yenilemede kaybolur */
  }
}
