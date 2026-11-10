import { t } from '@/lib/i18n';

/** KVKK aydınlatma ve açık rıza metinleri — YER TUTUCU, hukuk onayı bekliyor. */
export default function Kvkk() {
  return (
    <>
      <p className="alert">{t('F-WEB-LEGAL-PENDING')}</p>
      <h1 id="aydinlatma">{t('F-WEB-KVKK-NOTICE')}</h1>
      <p>{t('F-WEB-KVKK-BODY')}</p>
      <h2 id="acik-riza">{t('F-WEB-CONSENT-TEXT')}</h2>
      <p>{t('F-WEB-CONSENT-BODY')}</p>
    </>
  );
}
