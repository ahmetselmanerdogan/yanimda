import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { DevicePanel } from './components/Devices';
import { DispatchPanel } from './components/Dispatch';
import { EventCard, type OperatorResult } from './components/EventCard';
import { ClosePanel, EscalateDialog, PersonPanel, PhoneBar, TopBar } from './components/Panels';
import { QueueList } from './components/Queue';
import {
  ApiError,
  CALL_ACTIVE,
  type CallView,
  type CloseOutcome,
  type DispatchScript,
  type EventWithChain,
  type OperatorStatus,
  type PersonCard,
  type SelfStatus,
  type StepResultBody,
  type TelephonyConfig,
} from './lib/api';
import type { Backend } from './lib/backend';
import { promptPending, welfareReasonCode } from './lib/devices';
import { t } from './lib/i18n';
import { commandFor, type Mode } from './lib/keys';
import { isDeviceStep } from './lib/ladder';
import { canTakeOver, keepSelection, queueReducer } from './lib/queue';
import { type PhoneSnapshot, startSoftphone } from './lib/softphone';
import { alertSound } from './lib/sound';
import { type Pane, useViewport } from './lib/viewport';

const HEARTBEAT_MS = 60_000;
const OPEN_STATES = ['OPERATOR_ASSIGNED', 'CONTACT_CHAIN', 'CONFIRMED_OK', 'CONFIRMED_EMERGENCY', 'DISPATCH'];

const isEditing = (el: Element | null) =>
  !!el &&
  (el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'radio'));

/** T-023 operatör konsolu: düzen 04 "Operatör konsolu" (üst bar, kuyruk, olay kartı, kişi paneli, telefon barı). */
export interface Operator {
  sub: string;
  name: string;
}

export function Console({
  operator,
  backend,
  training = false,
  onLogout,
  onSupervisor,
  onAdmin,
}: {
  operator: Operator;
  backend: Backend;
  training?: boolean;
  onLogout(): void;
  /** T-074: amir ise panoya geçiş. */
  onSupervisor?(): void;
  /** Amir / yönetici: yönetim paneline geçiş. */
  onAdmin?(): void;
}) {
  const me = operator.sub;
  const operatorName = operator.name;
  const api = backend.api;

  const [queue, dispatch] = useReducer(queueReducer, { items: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<EventWithChain | null>(null);
  const [mode, setMode] = useState<Mode>('normal');
  const [note, setNote] = useState('');
  const [skipReason, setSkipReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [inbound, setInbound] = useState<{ queued: number; oldestQueuedSec: number | null }>({
    queued: 0,
    oldestQueuedSec: null,
  });
  // Duyarlı düzen: telefonda tek bölme (kuyruk / olay / kişi), tablette kişi paneli çekmece.
  const viewport = useViewport();
  const [pane, setPane] = useState<Pane>('queue');
  const [personOpen, setPersonOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const skipRef = useRef<HTMLInputElement>(null);
  const prevItems = useRef(queue.items);

  const item = queue.items.find((i) => i.eventId === selected) ?? null;
  const ev = detail && detail.event.id === selected ? detail.event : null;
  const chain = detail && detail.event.id === selected ? detail.chain : null;
  const mine = !!ev && ev.operatorId === me && OPEN_STATES.includes(ev.state);
  const current = chain?.steps.find((s) => s.n === chain.current) ?? null;
  const [dispatchScript, setDispatchScript] = useState<DispatchScript | null>(null);
  const need112 = mine && current?.kind === 'CALL_112' ? selected : null;
  useEffect(() => {
    setDispatchScript(null);
    if (!need112) return;
    api
      .dispatchScript(need112)
      .then((d) => selectedRef.current === need112 && setDispatchScript(d))
      .catch(() => undefined); // metin katalogdan "bilinmiyor" alanlarıyla gösterilir
  }, [need112, api]);

  // T-040 kişi kartı (tıbbi özet): yalnız olay bendeyken, olay başına bir kez.
  const [card, setCard] = useState<{ id: string; card: PersonCard | null } | null>(null);
  const needCard = mine ? selected : null;
  useEffect(() => {
    if (!needCard || card?.id === needCard) return;
    api
      .personCard(needCard)
      .then((c) => selectedRef.current === needCard && setCard({ id: needCard, card: c }))
      .catch(() => undefined);
  }, [needCard, card?.id, api]);

  // ---- canlı kuyruk ----
  useEffect(
    () =>
      backend.connect({
        onStatus: setOnline,
        onMessage: (m) => {
          if (m.type === 'snapshot') dispatch({ type: 'snapshot', items: m.items });
          else if (m.type === 'upsert') dispatch({ type: 'upsert', item: m.item, alarm: m.alarm });
          else if (m.type === 'remove') dispatch({ type: 'remove', eventId: m.eventId });
          else if (m.type === 'alert') setFlash(t(m.alert.code, { type: t(`O-TYPE-${m.alert.eventType}`) }));
          else if (m.type === 'inbound') setInbound({ queued: m.queued, oldestQueuedSec: m.oldestQueuedSec });
        },
      }),
    [backend],
  );

  useEffect(() => {
    if (!queue.arrived) return;
    const type = (queue.alarm ?? queue.arrived.type) as typeof queue.arrived.type;
    alertSound(type, queue.arrived.priority);
    setFlash(
      queue.alarm
        ? t('O-UI-NEW-ALARM', { type: t(`O-TYPE-${type}`) })
        : t('O-UI-NEW-EVENT', { type: t(`O-TYPE-${type}`) }),
    );
  }, [queue.arrived, queue.alarm]);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(id);
  }, [flash]);

  useEffect(() => {
    setSelected((s) => keepSelection(prevItems.current, queue.items, s));
    prevItems.current = queue.items;
  }, [queue.items]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // ---- seçili olay ayrıntısı: seçim veya olayın durumu/sahibi değişince ----
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const load = useCallback(
    async (id: string) => {
      try {
        const d = await api.event(id);
        if (id === selectedRef.current) setDetail(d); // geç gelen eski yanıtı yok say
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) setError(t('O-UI-ERROR', { detail: (e as Error).message }));
      }
    },
    [api],
  );
  const itemKey = item ? `${item.eventId}:${item.state}:${item.lockedBy ?? ''}` : '';
  useEffect(() => {
    setMode('normal');
    setError(null);
    if (selected) void load(selected);
    else setDetail(null);
  }, [selected, load]);
  useEffect(() => {
    if (selected && itemKey) void load(selected);
  }, [itemKey, selected, load]);

  // T-050: süren arama varken durum webhook'larla değişir; kısa aralıkla yenile.
  const callActive = !!detail?.calls?.some(
    (c) => CALL_ACTIVE.includes(c.status) || (c.status === 'completed' && c.answered && !c.recorded),
  );
  useEffect(() => {
    if (!callActive || !selected) return;
    const id = setInterval(() => void load(selected), 1500);
    return () => clearInterval(id);
  }, [callActive, selected, load]);

  // T-089: operatörün sorusu cevap bekliyorken (cihaz cevabı / süre dolması) ayrıntıyı yenile.
  const awaitingAnswer = promptPending(detail?.ladder?.prompts, now);
  useEffect(() => {
    if (!awaitingAnswer || !selected) return;
    const id = setInterval(() => void load(selected), 3000);
    return () => clearInterval(id);
  }, [awaitingAnswer, selected, load]);

  useEffect(() => {
    if (!mine || !selected) return;
    const id = setInterval(() => void api.heartbeat(selected).catch(() => undefined), HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [mine, selected, api]);

  // ---- T-051 yazılım telefonu: girişte başlar (mikrofon izni), oturum boyunca yaşar ----
  const [phoneState, setPhoneState] = useState<PhoneSnapshot>({
    device: 'starting',
    connected: false,
    incoming: null,
    inbound: false,
  });
  const phoneRef = useRef<ReturnType<typeof startSoftphone> | null>(null);
  useEffect(() => {
    const phone = startSoftphone({ token: () => api.telephonyToken(), training });
    phoneRef.current = phone;
    const off = phone.subscribe(setPhoneState);
    return () => {
      off();
      phone.destroy();
      phoneRef.current = null;
    };
  }, [api, training]);
  // Gelen SOS aramasının olayı: çalarken gelir, görüşme boyunca "Olayı aç" için tutulur.
  const [inboundEventId, setInboundEventId] = useState<string | null>(null);
  useEffect(() => {
    if (phoneState.incoming) setInboundEventId(phoneState.incoming.eventId);
    else if (!phoneState.inbound) setInboundEventId(null);
  }, [phoneState.incoming, phoneState.inbound]);

  // ---- operatörün kendi durumu (gelen SOS yönlendirmesi) ve telefoni yapılandırması (T-052 masa hattı) ----
  const [myStatus, setMyStatus] = useState<OperatorStatus | null>(null);
  const [telConfig, setTelConfig] = useState<TelephonyConfig | null>(null);
  useEffect(() => {
    void api
      .myStatus()
      .then((s) => setMyStatus(s.status))
      .catch(() => undefined);
    void api
      .telephonyConfig()
      .then(setTelConfig)
      .catch(() => undefined);
  }, [api]);
  const changeMyStatus = (s: SelfStatus) =>
    void api
      .setMyStatus(s)
      .then((r) => setMyStatus(r.status))
      .catch((e: Error) => setError(t('O-UI-ERROR', { detail: e.message })));

  const activeCall: CallView | null =
    (mine && detail?.event.id === selected
      ? detail.calls?.filter((c) => CALL_ACTIVE.includes(c.status)).at(-1)
      : undefined) ?? null;

  // ---- işlemler ----
  const run = useCallback(
    async (fn: () => Promise<EventWithChain | void>) => {
      setBusy(true);
      setError(null);
      try {
        const r = await fn();
        if (r) setDetail(r);
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setError(t('O-UI-CONFLICT'));
          if (selectedRef.current) void load(selectedRef.current);
        } else setError(t('O-UI-ERROR', { detail: (e as Error).message }));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const claim = () =>
    selected &&
    item &&
    (item.state === 'OPERATOR_QUEUE' || canTakeOver(item, me, now)) &&
    void run(() => api.claim(selected));
  const call = () => mine && current && void run(() => api.call(selected!, current.n));
  const send = async (body: Omit<StepResultBody, 'note'>) => {
    if (!mine || !current) return;
    const ok = await run(() =>
      api.result(selected!, current.n, { ...body, ...(note.trim() ? { note: note.trim() } : {}) }),
    );
    if (ok) {
      setNote('');
      setSkipReason('');
      setMode('normal');
    }
  };
  const result = (r: OperatorResult | 'OFFLINE_SKIPPED') => {
    if (!mine || !current || r === 'OFFLINE_SKIPPED') return; // çevrimdışı atlama yalnız sistemin
    if (r === 'SILENT' && !isDeviceStep(current)) return; // T-087: yalnız sesli cihaz aramasında
    if (r === 'REACHED' && current.kind !== 'CALL_112') setMode('assess');
    else void send({ result: r });
  };
  const assess = (a: 'OK' | 'EMERGENCY' | 'CONTINUE') =>
    void send(a === 'CONTINUE' ? { result: 'REACHED' } : { result: 'REACHED', assessment: a });
  const skip = () => {
    if (!mine || !current) return;
    setMode('skip');
    setTimeout(() => skipRef.current?.focus(), 0);
  };
  const skipSubmit = () => skipReason.trim() && void send({ result: 'SKIPPED', reason: skipReason.trim() });
  /** Gerçek SOS / düşme: ulaşılamadıysa da 112 sorulur (sunucu aranmadıysa amire uyarır). */
  const alarm = !!ev && !ev.isTest && (ev.type === 'SOS' || ev.type === 'FALL');
  const allowedOutcomes = (): CloseOutcome[] =>
    ev?.state === 'CONFIRMED_EMERGENCY' || ev?.state === 'DISPATCH'
      ? ['EMERGENCY']
      : ev?.state === 'CONFIRMED_OK'
        ? ['OK', 'FALSE_ALARM', 'TEST']
        : ['OK', 'FALSE_ALARM', 'UNREACHABLE', 'TEST', 'EMERGENCY'];
  const close = async (outcome: CloseOutcome, closeNote: string, followUp?: number, notified112?: boolean) => {
    const ok = await run(() => api.close(selected!, outcome, closeNote || undefined, followUp, notified112));
    if (ok) {
      setMode('normal');
      setNote('');
    }
  };
  const phoneAction = (fn: (callId: string) => Promise<unknown>) => {
    if (!activeCall) return;
    const id = activeCall.id;
    void run(async () => {
      await fn(id);
      if (selectedRef.current) return api.event(selectedRef.current);
    });
  };
  const escalate = async (reason: string) => {
    if (await run(() => api.escalate(selected!, reason))) setMode('normal');
  };

  // ---- klavye (E-10) ----
  const handlers = useRef<(e: KeyboardEvent) => void>(() => undefined);
  handlers.current = (e: KeyboardEvent) => {
    const cmd = commandFor(
      {
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        editing: isEditing(document.activeElement),
      },
      mode,
    );
    if (!cmd) return;
    const idx = queue.items.findIndex((i) => i.eventId === selected);
    switch (cmd.kind) {
      case 'escape':
        if (isEditing(document.activeElement)) (document.activeElement as HTMLElement).blur();
        setMode('normal');
        return;
      case 'up':
      case 'down': {
        const next = queue.items[Math.min(Math.max(idx + (cmd.kind === 'up' ? -1 : 1), 0), queue.items.length - 1)];
        if (next) setSelected(next.eventId);
        break;
      }
      case 'claim':
        if (document.activeElement?.tagName === 'BUTTON') return; // düğmenin kendi Enter'ı
        claim();
        break;
      case 'call':
        call();
        break;
      case 'result':
        result(cmd.result);
        break;
      case 'assess':
        assess(cmd.assessment);
        break;
      case 'skip':
        skip();
        break;
      case 'note':
        if (!mine) return;
        setTimeout(() => noteRef.current?.focus(), 0);
        break;
      case 'close':
        if (mine) setMode('close');
        break;
      case 'escalate':
        if (mine) setMode('escalate');
        break;
    }
    e.preventDefault();
  };
  useEffect(() => {
    const l = (e: KeyboardEvent) => handlers.current(e);
    window.addEventListener('keydown', l);
    return () => window.removeEventListener('keydown', l);
  }, []);

  const scriptVars = {
    operator: operatorName,
    name: item?.person?.displayName,
    age: item?.person?.age ?? undefined,
    type: item ? t(`O-TYPE-${item.type}`) : undefined,
  };

  return (
    <div
      className={`layout v-${viewport} pane-${pane}${personOpen ? ' person-open' : ''}${training ? ' training' : ''}`}
      data-viewport={viewport}
    >
      <TopBar
        training={training}
        operator={operatorName}
        online={online}
        count={queue.items.length}
        flash={flash}
        inbound={inbound}
        onLogout={onLogout}
        myStatus={myStatus}
        onMyStatus={changeMyStatus}
        {...(onSupervisor ? { onSupervisor } : {})}
        {...(onAdmin ? { onAdmin } : {})}
      />
      <QueueList
        items={queue.items}
        selected={selected}
        me={me}
        now={now}
        onSelect={(id) => {
          setSelected(id);
          setPane('event');
        }}
      />
      <main className="center">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {item ? (
          <EventCard
            item={item}
            detail={detail && detail.event.id === selected ? detail : null}
            me={me}
            now={now}
            mode={mode}
            busy={busy}
            note={note}
            skipReason={skipReason}
            scriptVars={scriptVars}
            dispatch={dispatchScript}
            deskLine={telConfig?.deskLine ?? null}
            noteRef={noteRef}
            skipRef={skipRef}
            onNote={setNote}
            onSkipReason={setSkipReason}
            onClaim={claim}
            onCall={call}
            onResult={result}
            onAssess={assess}
            onSkip={skip}
            onSkipSubmit={skipSubmit}
            onScriptRead={(n) => void run(() => api.scriptRead(selected!, n))}
            onClose={() => setMode('close')}
            onEscalate={() => setMode('escalate')}
          />
        ) : (
          <p className="muted pad">{t('O-UI-NO-SELECTION')}</p>
        )}
        {ev && (
          <DevicePanel
            key={ev.id}
            api={api}
            event={ev}
            mine={mine}
            now={now}
            prompts={detail?.ladder?.prompts}
            onSent={() => {
              if (selected) void load(selected);
            }}
            onError={(m) => setError(m)}
          />
        )}
        {ev?.type === 'WELFARE_CHECK' && (
          <section className="script welfare-script" aria-labelledby="welfare-script-title" data-testid="welfare">
            <h2 id="welfare-script-title">{t('O-UI-SCRIPT-WELFARE')}</h2>
            {welfareReasonCode(detail?.ladder?.welfareReason) && (
              <p className="gap-reason">
                {t('O-UI-WELFARE-REASON', { reason: t(welfareReasonCode(detail?.ladder?.welfareReason)!) })}
              </p>
            )}
            <p>{t('O-SCRIPT-WELFARE', scriptVars)}</p>
            <p className="muted small">{t('O-UI-WELFARE-112')}</p>
          </section>
        )}
        {ev?.type === 'COVERAGE_GAP' && (
          <section className="script coverage-script" aria-labelledby="coverage-script-title">
            <h2 id="coverage-script-title">{t('O-UI-SCRIPT-COVERAGE')}</h2>
            <p>{t('O-SCRIPT-COVERAGE', scriptVars)}</p>
          </section>
        )}
        {item && (ev?.state ?? item.state) === 'DISPATCH' && (
          <DispatchPanel key={item.eventId} api={api} eventId={item.eventId} />
        )}
        {ev?.type === 'CALLBACK' && ev.sourceSignalIds?.some((s) => s.startsWith('wellness:')) && (
          <section className="script wellness-script" aria-labelledby="wellness-script-title">
            <h2 id="wellness-script-title">{t('O-UI-SCRIPT-WELLNESS')}</h2>
            <p>{t('O-SCRIPT-WELLNESS', scriptVars)}</p>
          </section>
        )}
      </main>
      {viewport === 'tablet' && (
        <button
          type="button"
          className="person-toggle"
          aria-expanded={personOpen}
          aria-controls="person-panel"
          onClick={() => setPersonOpen((o) => !o)}
        >
          {t('O-UI-PERSON')}
        </button>
      )}
      <PersonPanel item={item} card={card && card.id === selected ? card.card : undefined} mine={mine} />
      <PhoneBar
        phone={phoneState}
        call={activeCall}
        now={now}
        busy={busy}
        onHold={(on) => phoneAction((id) => api.hold(id, on))}
        onAddFamily={() => phoneAction((id) => api.conference(id))}
        onHangup={() => {
          phoneRef.current?.hangup();
          phoneAction((id) => api.hangup(id));
        }}
        inboundEventId={inboundEventId}
        onAccept={() => phoneRef.current?.accept()}
        onReject={() => phoneRef.current?.reject()}
        onOpenEvent={setSelected}
      />
      {viewport === 'phone' && (
        <nav className="tabbar" aria-label={t('O-UI-NAV')}>
          {(['queue', 'event', 'person'] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-current={pane === p ? 'page' : undefined}
              className={pane === p ? 'on' : ''}
              onClick={() => setPane(p)}
            >
              {p === 'queue'
                ? t('O-UI-QUEUE', { n: queue.items.length })
                : t(p === 'event' ? 'O-UI-NAV-EVENT' : 'O-UI-PERSON')}
            </button>
          ))}
        </nav>
      )}
      {mode === 'close' && mine && (
        <ClosePanel
          allowed={allowedOutcomes()}
          initialNote={note}
          busy={busy}
          ask112For={ev?.state === 'DISPATCH' ? [] : alarm ? ['EMERGENCY', 'UNREACHABLE'] : ['EMERGENCY']}
          onSubmit={(o, n, f, x) => void close(o, n, f, x)}
          onCancel={() => setMode('normal')}
        />
      )}
      {mode === 'escalate' && mine && (
        <EscalateDialog busy={busy} onSubmit={(r) => void escalate(r)} onCancel={() => setMode('normal')} />
      )}
    </div>
  );
}
