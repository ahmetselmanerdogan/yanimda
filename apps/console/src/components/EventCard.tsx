import type { ChainStep } from '@yanimda/contracts';
import type { RefObject } from 'react';

import { CALL_ACTIVE, type CallView, type DispatchScript, type EventWithChain, type QueueItem } from '../lib/api';
import { action, t } from '../lib/i18n';
import type { Mode } from '../lib/keys';
import { clock, slaOf } from '../lib/sla';
import { ScriptPanel } from './Panels';

interface Props {
  item: QueueItem;
  detail: EventWithChain | null;
  me: string;
  now: number;
  mode: Mode;
  busy: boolean;
  note: string;
  skipReason: string;
  scriptVars: Record<string, string | number | null | undefined>;
  dispatch: DispatchScript | null;
  /** T-052: masa sabit hattı (112 geri arama numarası), ulusal gösterim. */
  deskLine?: string | null;
  noteRef: RefObject<HTMLTextAreaElement>;
  skipRef: RefObject<HTMLInputElement>;
  onNote(v: string): void;
  onSkipReason(v: string): void;
  onClaim(): void;
  onCall(): void;
  onResult(r: 'REACHED' | 'NO_ANSWER' | 'BUSY' | 'WRONG_NUMBER'): void;
  onAssess(a: 'OK' | 'EMERGENCY' | 'CONTINUE'): void;
  onSkip(): void;
  onSkipSubmit(): void;
  onScriptRead(n: number): void;
  onClose(): void;
  onEscalate(): void;
}

const stepLabel = (s: ChainStep) => t(s.label, { n: s.contactIndex });
const KEY_OF: Record<string, string> = { REACHED: '1', NO_ANSWER: '2', BUSY: '3', WRONG_NUMBER: '4' };

/** T-050: adımın son CPaaS araması — durum, süre, kayıt, sonuç önerisi (operatör onaylar). */
function CallStatusLine({ call, onApply }: { call: CallView; onApply(r: CallView['suggestedResult']): void }) {
  const active = CALL_ACTIVE.includes(call.status);
  return (
    <div className={`call-line${active ? ' active' : ''}`} role="status" aria-live="polite">
      <span>{t(`O-CALL-${call.status}`)}</span>
      {call.durationSec !== null && <span className="muted">{t('O-CALL-DURATION', { sec: call.durationSec })}</span>}
      {call.recorded && <span className="muted">{t('O-CALL-RECORDED')}</span>}
      {call.suggestedResult && (
        <button type="button" className="suggest" onClick={() => onApply(call.suggestedResult)}>
          {t('O-CALL-SUGGEST', { result: t(`O-RES-${call.suggestedResult}`) })}{' '}
          <kbd>{KEY_OF[call.suggestedResult]}</kbd>
        </button>
      )}
    </div>
  );
}

const RESULT_KEYS: [string, 'REACHED' | 'NO_ANSWER' | 'BUSY' | 'WRONG_NUMBER'][] = [
  ['1', 'REACHED'],
  ['2', 'NO_ANSWER'],
  ['3', 'BUSY'],
  ['4', 'WRONG_NUMBER'],
];

/** E-03 olay kartı: başlık, SLA sayaçları, adım listesi (E-04), not, konuşma metni. */
export function EventCard(p: Props) {
  const { item, detail, me, now } = p;
  const ev = detail?.event ?? null;
  const chain = detail?.chain ?? null;
  const mine = (ev?.operatorId ?? item.lockedBy) === me;
  const current = chain?.steps.find((s) => s.n === chain.current) ?? null;
  const call = current ? (detail?.calls ?? []).filter((c) => c.stepN === current.n).at(-1) : undefined;
  const firstCalled = chain?.steps.find((s) => s.calledAt)?.calledAt;
  const sla = slaOf(item, ev, firstCalled, now);
  const state = ev?.state ?? item.state;
  const open = ['OPERATOR_ASSIGNED', 'CONTACT_CHAIN', 'CONFIRMED_OK', 'CONFIRMED_EMERGENCY', 'DISPATCH'].includes(
    state,
  );

  return (
    <section className="card" aria-labelledby="event-title">
      <header className="card-head">
        <span className={`prio big p${item.priority}`}>{t('O-UI-PRIORITY', { n: item.priority })}</span>
        <h1 id="event-title">
          {t(`O-TYPE-${item.type}`)}
          {item.isTest && <span className="badge-test">{t('O-UI-TEST')}</span>}
        </h1>
        <span className={`state s-${state}`}>{t(`O-STATE-${state}`)}</span>
      </header>

      <dl className="sla" aria-live="polite">
        <div>
          <dt>{t('O-UI-AGE')}</dt>
          <dd>{clock(sla.ageSec)}</dd>
        </div>
        {sla.claimLeftSec !== undefined && (
          <div className={sla.claimLeftSec < 0 ? 'late' : ''}>
            <dt>{t('O-UI-CLAIM-SLA')}</dt>
            <dd>{sla.claimLeftSec < 0 ? t('O-UI-OVERDUE') : clock(sla.claimLeftSec)}</dd>
          </div>
        )}
        {sla.firstCallLeftSec !== undefined && (
          <div className={sla.firstCallLeftSec < 0 ? 'late' : ''}>
            <dt>{t('O-UI-CALL-SLA')}</dt>
            <dd>{sla.firstCallLeftSec < 0 ? t('O-UI-OVERDUE') : clock(sla.firstCallLeftSec)}</dd>
          </div>
        )}
      </dl>

      {state === 'OPERATOR_QUEUE' && (
        <div className="claim">
          <p>{t('O-UI-CLAIM')}</p>
          <button type="button" className="primary" onClick={p.onClaim} disabled={p.busy}>
            {action('O-UI-CLAIM')} <kbd>Enter</kbd>
          </button>
        </div>
      )}
      {!mine && item.lockedBy && <p className="muted">{t('O-UI-LOCKED-BY')}</p>}

      {chain && (
        <section aria-labelledby="steps-title">
          <h2 id="steps-title">{t('O-UI-STEPS')}</h2>
          <ol className="steps">
            {chain.steps.map((s) => (
              <StepRow key={s.n} step={s} current={s.n === chain.current} />
            ))}
          </ol>
          {chain.current === null && open && <p className="muted">{t('O-UI-CHAIN-DONE')}</p>}
        </section>
      )}

      {mine && current && open && (
        <section className="step-actions" aria-label={stepLabel(current)}>
          <div className="row">
            <button type="button" onClick={p.onCall} disabled={p.busy}>
              {current.kind === 'CALL_112'
                ? t('O-CALL-112-DONE')
                : current.calledAt
                  ? t('O-UI-CALLING')
                  : t('O-UI-CALL')}{' '}
              <kbd>A</kbd>
            </button>
            {RESULT_KEYS.map(([k, r]) => (
              <button type="button" key={r} onClick={() => p.onResult(r)} disabled={p.busy}>
                {t(`O-RES-${r}`)} <kbd>{k}</kbd>
              </button>
            ))}
            <button type="button" onClick={p.onSkip} disabled={p.busy}>
              {t('O-RES-SKIPPED')} <kbd>5</kbd>
            </button>
          </div>
          {call && <CallStatusLine call={call} onApply={(r) => r && p.onResult(r)} />}
          {current.kind === 'CALL_112' && (
            <div className="desk-112" role="note" data-testid="desk-112">
              <p>
                <strong>{t('O-CALL-112-DESK')}</strong>
                <span className="badge-manual">{t('O-CALL-112-BADGE')}</span>
              </p>
              {p.deskLine && <p>{t('O-CALL-112-CALLBACK', { desk: p.deskLine })}</p>}
              <p className="muted small">
                {t('O-CALL-MANUAL')} {t('O-CALL-112-STEPS')}
              </p>
            </div>
          )}
          {p.mode === 'assess' && (
            <div className="row assess" role="group" aria-label={t('O-UI-ASSESS')}>
              <span>{t('O-UI-ASSESS')}</span>
              <button type="button" className="ok" onClick={() => p.onAssess('OK')}>
                {t('O-ASSESS-OK')} <kbd>1</kbd>
              </button>
              <button type="button" className="danger" onClick={() => p.onAssess('EMERGENCY')}>
                {t('O-ASSESS-EMERGENCY')} <kbd>2</kbd>
              </button>
              <button type="button" onClick={() => p.onAssess('CONTINUE')}>
                {t('O-UI-ASSESS-CONTINUE')} <kbd>3</kbd>
              </button>
            </div>
          )}
          {p.mode === 'skip' && (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                p.onSkipSubmit();
              }}
            >
              <label htmlFor="skip-reason">{t('O-UI-SKIP-REASON')}</label>
              <input
                id="skip-reason"
                ref={p.skipRef}
                value={p.skipReason}
                maxLength={500}
                onChange={(e) => p.onSkipReason(e.target.value)}
              />
              <button type="submit" disabled={!p.skipReason.trim() || p.busy}>
                {t('O-RES-SKIPPED')}
              </button>
            </form>
          )}
          <label htmlFor="note" className="note-label">
            {t('O-UI-NOTE')} <kbd>N</kbd>
          </label>
          <textarea
            id="note"
            ref={p.noteRef}
            value={p.note}
            maxLength={2000}
            rows={2}
            onChange={(e) => p.onNote(e.target.value)}
          />
          {current.script && (
            <ScriptPanel
              step={current}
              vars={p.scriptVars}
              dispatch={p.dispatch}
              onRead={() => p.onScriptRead(current.n)}
            />
          )}
        </section>
      )}

      {mine && open && (
        <div className="row end">
          <button type="button" className="danger" onClick={p.onEscalate} disabled={p.busy}>
            {action('O-UI-112')} <kbd>Ctrl+1</kbd>
          </button>
          <button type="button" className="primary" onClick={p.onClose} disabled={p.busy}>
            {action('O-UI-CLOSE')} <kbd>C</kbd>
          </button>
        </div>
      )}
    </section>
  );
}

function StepRow({ step, current }: { step: ChainStep; current: boolean }) {
  return (
    <li
      className={`step${current ? ' current' : ''}${step.result ? ' done' : ''}`}
      aria-current={current ? 'step' : undefined}
    >
      <span className="step-n">{step.n}</span>
      <span className="step-label">
        {stepLabel(step)}
        {step.kind === 'CALL_112' && <span className="badge-manual">{t('O-CALL-112-BADGE')}</span>}
      </span>
      <span className="step-result small">
        {step.result ? t(`O-RES-${step.result}`) : current && step.calledAt ? t('O-UI-CALLING') : ''}
        {step.assessment && ` · ${t(`O-ASSESS-${step.assessment}`)}`}
      </span>
      {step.timeoutSec > 0 && <span className="muted small">{t('O-UI-SECONDS', { n: step.timeoutSec })}</span>}
    </li>
  );
}
