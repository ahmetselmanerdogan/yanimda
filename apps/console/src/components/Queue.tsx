import type { QueueItem } from '../lib/api';
import { t } from '../lib/i18n';
import { clock, slaOf } from '../lib/sla';

interface Props {
  items: QueueItem[];
  selected: string | null;
  me: string;
  now: number;
  onSelect(id: string): void;
}

/** E-02 kuyruk (240 px): öncelik rengi, tip, kişi, yaş, kilit. */
export function QueueList({ items, selected, me, now, onSelect }: Props) {
  return (
    <nav className="queue" aria-label={t('O-UI-QUEUE', { n: items.length })}>
      <h2 className="queue-title">{t('O-UI-QUEUE', { n: items.length })}</h2>
      {items.length === 0 ? (
        <p className="muted pad">{t('O-UI-QUEUE-EMPTY')}</p>
      ) : (
        <ul role="listbox" aria-label={t('O-UI-QUEUE', { n: items.length })}>
          {items.map((i) => (
            <QueueRow key={i.eventId} item={i} active={i.eventId === selected} me={me} now={now} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </nav>
  );
}

function QueueRow({
  item,
  active,
  me,
  now,
  onSelect,
}: {
  item: QueueItem;
  active: boolean;
  me: string;
  now: number;
  onSelect(id: string): void;
}) {
  const sla = slaOf(item, null, undefined, now);
  const lock = item.lockedBy ? (item.lockedBy === me ? t('O-UI-MINE') : t('O-UI-LOCKED-BY')) : null;
  const overdue = sla.claimLeftSec !== undefined && sla.claimLeftSec < 0;
  return (
    <li
      role="option"
      aria-selected={active}
      tabIndex={-1}
      className={`queue-row p${item.priority}${active ? ' active' : ''}${overdue ? ' overdue' : ''}`}
      data-event-id={item.eventId}
      onClick={() => onSelect(item.eventId)}
    >
      <span className={`prio p${item.priority}`}>{t('O-UI-PRIORITY', { n: item.priority })}</span>
      <span className="queue-main">
        <strong>{t(`O-TYPE-${item.type}`)}</strong>
        {item.isTest && <span className="badge-test">{t('O-UI-TEST')}</span>}
        <span className="muted small">{item.person?.displayName ?? t('O-UI-PERSON-UNKNOWN')}</span>
      </span>
      <span className="queue-side small">
        <time dateTime={item.createdAt}>{clock(sla.ageSec)}</time>
        <span className="muted">{lock ?? t(`O-STATE-${item.state}`)}</span>
      </span>
    </li>
  );
}
