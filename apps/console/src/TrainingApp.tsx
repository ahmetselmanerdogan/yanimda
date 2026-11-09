import { useState } from 'react';

import { Console } from './Console';
import { t } from './lib/i18n';
import { trainingBackend } from './lib/training';

/** Eğitim modu (?training=1, T-026): giriş ve gerçek API yok, sahte olaylar. */
export default function TrainingApp() {
  const [backend] = useState(trainingBackend);
  return (
    <Console
      operator={{ sub: 'egitim', name: t('O-UI-TRAINING') }}
      backend={backend}
      training
      onLogout={() => window.location.assign('/')}
    />
  );
}
