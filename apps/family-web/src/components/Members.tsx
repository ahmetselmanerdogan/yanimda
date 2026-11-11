'use client';

import { useCallback, useEffect, useState } from 'react';

import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/flow';
import { t } from '@/lib/i18n';
import {
  formatDateTime,
  memberAction,
  memberErrorCode,
  type MemberRole,
  type MemberView,
  roleCode,
} from '@/lib/members';

/**
 * T-040 "Aile üyeleri" (C-02, C-04): liste; hesap sahibi davet kodu üretir ve üye çıkarır; üye kendi üyeliğinden
 * ayrılır. Başka üyenin e-posta/telefonu API'den gelmez; satırlar rol + yakınlık ile tanınır.
 */
export function Members({
  token,
  personId,
  myRole,
  onLeft,
  onUnauthorized,
}: {
  token: string;
  personId: string;
  myRole: MemberRole | null;
  /** Kendi üyeliğinden ayrıldı: kişi artık listede olmamalı. */
  onLeft: () => void;
  onUnauthorized: () => void;
}) {
  const [items, setItems] = useState<MemberView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [relation, setRelation] = useState('');
  const [invite, setInvite] = useState<{ code: string; expiresAt: string } | null>(null);

  const fail = useCallback(
    (e: unknown, step: Parameters<typeof memberErrorCode>[1]) => {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else setError(memberErrorCode(e, step));
    },
    [onUnauthorized],
  );

  const load = useCallback(async () => {
    try {
      setItems((await api.members(token, personId)).items);
    } catch (e) {
      fail(e, 'list');
    }
  }, [token, personId, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createInvite() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.createMemberInvite(token, personId, relation.trim() || null);
      setInvite({ code: r.code, expiresAt: r.expiresAt });
      setRelation('');
    } catch (e) {
      fail(e, 'invite');
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: MemberView) {
    const leaving = m.isMe;
    if (!window.confirm(t(leaving ? 'F-WEB-MEMBERS-LEAVE-CONFIRM' : 'F-WEB-MEMBERS-REMOVE-CONFIRM'))) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.removeMember(token, personId, m.id);
      if (leaving) {
        onLeft();
        return;
      }
      setNotice('F-WEB-MEMBERS-REMOVED');
      await load();
    } catch (e) {
      fail(e, 'remove');
    } finally {
      setBusy(false);
    }
  }

  const who = (m: MemberView) => [t(roleCode(m)), m.relation].filter(Boolean).join(' · ');
  const relationId = `member-relation-${personId}`;

  return (
    <section aria-labelledby={`members-${personId}`}>
      <h3 id={`members-${personId}`}>{t('F-WEB-MEMBERS')}</h3>
      <p className="muted">{t('F-WEB-MEMBERS-HINT')}</p>
      {error && (
        <p className="alert" role="alert">
          {t(error)}
        </p>
      )}
      {notice && (
        <p className="alert ok" role="status">
          {t(notice)}
        </p>
      )}
      {items && (
        <ul className="members">
          {items.map((m) => {
            const action = memberAction(m, items, myRole);
            return (
              <li key={m.id}>
                <div>
                  <strong>{who(m)}</strong>
                  {m.isMe && <span className="badge">{t('F-WEB-MEMBERS-ME')}</span>}
                  <div className="muted">{t('F-WEB-MEMBERS-SINCE', { date: formatDate(m.createdAt) })}</div>
                </div>
                {action && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    aria-label={action === 'leave' ? undefined : t('F-WEB-MEMBERS-REMOVE-LABEL', { who: who(m) })}
                    onClick={() => void remove(m)}
                  >
                    {t(action === 'leave' ? 'F-WEB-MEMBERS-LEAVE' : 'F-WEB-MEMBERS-REMOVE')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {myRole === 'OWNER' && (
        <>
          <label htmlFor={relationId}>{t('F-WEB-MEMBERS-RELATION')}</label>
          <input
            id={relationId}
            type="text"
            maxLength={50}
            value={relation}
            onChange={(e) => setRelation(e.target.value)}
          />
          <div className="row">
            <button type="button" disabled={busy} onClick={() => void createInvite()}>
              {t('F-WEB-MEMBERS-INVITE')}
            </button>
          </div>
          {invite && (
            <div className="alert ok" role="status">
              <p className="code">{t('F-WEB-MEMBERS-CODE', { code: invite.code })}</p>
              <p>{t('F-WEB-MEMBERS-CODE-HINT', { date: formatDateTime(invite.expiresAt) })}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
