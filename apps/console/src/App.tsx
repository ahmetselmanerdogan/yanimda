import type { User } from 'oidc-client-ts';
import { lazy, Suspense, useEffect, useState } from 'react';

import { Console } from './Console';
import { OPERATOR_ROLES, restoreSession, rolesOf, sessionLost, userManager } from './lib/auth';
import { realBackend } from './lib/backend';
import { action, t } from './lib/i18n';
import { trainingRequested } from './lib/training-flag';
import { SupervisorBoard } from './Supervisor';

/** T-074: amir panosu `/supervisor` (giriş dönüşü köke düşer; konsoldaki düğmeyle geçilir). */
const SUPERVISOR_PATH = '/supervisor';

type Phase = { kind: 'loading' } | { kind: 'anonymous'; failed?: boolean } | { kind: 'ready'; user: User };

/** Eğitim modu (?training=1, T-026): üretim derlemesinde modül hiç yoktur. */
const TrainingApp = import.meta.env.PROD ? null : lazy(() => import('./TrainingApp'));

export function App() {
  if (TrainingApp && trainingRequested())
    return (
      <Suspense fallback={null}>
        <TrainingApp />
      </Suspense>
    );
  return <LiveApp />;
}

function LiveApp() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [backend] = useState(realBackend);
  const [board, setBoard] = useState(() => window.location.pathname === SUPERVISOR_PATH);
  const go = (on: boolean) => {
    window.history.pushState(null, '', on ? SUPERVISOR_PATH : '/');
    setBoard(on);
  };
  useEffect(() => {
    const pop = () => setBoard(window.location.pathname === SUPERVISOR_PATH);
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  useEffect(() => {
    restoreSession()
      .then((user) => setPhase(user ? { kind: 'ready', user } : { kind: 'anonymous' }))
      .catch(() => setPhase({ kind: 'anonymous', failed: true }));
    const loaded = (user: User) => setPhase({ kind: 'ready', user });
    const gone = () => setPhase({ kind: 'anonymous' });
    const renewFailed = () => void sessionLost().then((lost) => lost && gone());
    userManager.events.addUserLoaded(loaded);
    userManager.events.addUserSignedOut(gone);
    userManager.events.addSilentRenewError(renewFailed);
    return () => {
      userManager.events.removeUserLoaded(loaded);
      userManager.events.removeUserSignedOut(gone);
      userManager.events.removeSilentRenewError(renewFailed);
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
  const p = phase.user.profile;
  const name = String(p.name ?? p.preferred_username ?? '');
  const supervisor = rolesOf(phase.user).includes('SUPERVISOR');
  if (supervisor && board)
    return <SupervisorBoard backend={backend} operatorName={name} onBack={() => go(false)} onLogout={logout} />;
  return (
    <Console
      operator={{ sub: p.sub, name }}
      backend={backend}
      onLogout={logout}
      {...(supervisor ? { onSupervisor: () => go(true) } : {})}
    />
  );
}
