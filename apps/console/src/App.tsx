import type { User } from 'oidc-client-ts';
import { useEffect, useState } from 'react';

import { Console } from './Console';
import { OPERATOR_ROLES, restoreSession, rolesOf, userManager } from './lib/auth';
import { action, t } from './lib/i18n';

type Phase = { kind: 'loading' } | { kind: 'anonymous'; failed?: boolean } | { kind: 'ready'; user: User };

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  useEffect(() => {
    restoreSession()
      .then((user) => setPhase(user ? { kind: 'ready', user } : { kind: 'anonymous' }))
      .catch(() => setPhase({ kind: 'anonymous', failed: true }));
    const loaded = (user: User) => setPhase({ kind: 'ready', user });
    const gone = () => setPhase({ kind: 'anonymous' });
    userManager.events.addUserLoaded(loaded);
    userManager.events.addUserSignedOut(gone);
    userManager.events.addSilentRenewError(gone);
    return () => {
      userManager.events.removeUserLoaded(loaded);
      userManager.events.removeUserSignedOut(gone);
      userManager.events.removeSilentRenewError(gone);
    };
  }, []);

  const logout = () =>
    void userManager
      .signoutRedirect()
      .catch(() => userManager.removeUser().then(() => setPhase({ kind: 'anonymous' })));

  if (phase.kind === 'loading')
    return (
      <main className="gate">
        <p>{t('O-UI-LOGGING-IN')}</p>
      </main>
    );
  if (phase.kind === 'anonymous') {
    const code = phase.failed ? 'O-UI-LOGIN-FAILED' : 'O-UI-LOGIN';
    return (
      <main className="gate">
        <h1>{t('O-UI-TITLE')}</h1>
        <p>{t(code)}</p>
        <button type="button" className="primary" onClick={() => void userManager.signinRedirect()}>
          {action(code)}
        </button>
      </main>
    );
  }
  if (!rolesOf(phase.user).some((r) => OPERATOR_ROLES.includes(r)))
    return (
      <main className="gate">
        <h1>{t('O-UI-TITLE')}</h1>
        <p>{t('O-UI-NO-ROLE')}</p>
        <button type="button" onClick={logout}>
          {action('O-UI-NO-ROLE')}
        </button>
      </main>
    );
  return <Console user={phase.user} onLogout={logout} />;
}
