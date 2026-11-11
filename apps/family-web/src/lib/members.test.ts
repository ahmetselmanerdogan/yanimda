import catalog from '@yanimda/messages/tr.json';
import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import { memberAction, memberErrorCode, type MemberView, normalizeMemberCode, roleCode } from './members';

const m = (role: MemberView['role'], isMe = false, id = role + String(isMe)): MemberView => ({
  id,
  role,
  relation: null,
  createdAt: '2026-11-01T00:00:00Z',
  isMe,
});

describe('aile üyeleri (T-040)', () => {
  it('davet kodu: büyük/küçük harf, boşluk, tire; O→0, I/L→1; biçimsiz → null', () => {
    expect(normalizeMemberCode('7kq2m 9xd4r')).toBe('7KQ2M-9XD4R');
    expect(normalizeMemberCode('7KQ2M-9XD4R')).toBe('7KQ2M-9XD4R');
    expect(normalizeMemberCode('OKQ2M-9XDLI')).toBe('0KQ2M-9XD11');
    expect(normalizeMemberCode('7KQ2M-9XD4')).toBeNull();
    expect(normalizeMemberCode('7KQ2M-9XD4U')).toBeNull();
    expect(normalizeMemberCode('')).toBeNull();
  });

  it('hata → katalog kodu: sunucunun kodu önce, yoksa duruma göre; hepsi katalogda', () => {
    expect(memberErrorCode(new ApiError(400, 'F-MEMBER-CODE-USED'), 'accept')).toBe('F-MEMBER-CODE-USED');
    expect(memberErrorCode(new ApiError(400, 'BILINMEYEN-KOD'), 'accept')).toBe('F-MEMBER-CODE-INVALID');
    const codes = [
      memberErrorCode(new ApiError(400), 'accept'),
      memberErrorCode(new ApiError(409), 'accept'),
      memberErrorCode(new ApiError(403), 'remove'),
      memberErrorCode(new ApiError(429), 'invite'),
      memberErrorCode(new ApiError(500), 'list'),
      memberErrorCode(new Error('ağ'), 'list'),
      roleCode({ role: 'OWNER' }),
      roleCode({ role: 'MEMBER' }),
    ];
    expect(codes).toEqual([
      'F-MEMBER-CODE-INVALID',
      'F-MEMBER-ALREADY',
      'F-MEMBER-OWNER-ONLY',
      'F-WEB-ERROR-TOO-MANY',
      'F-WEB-ERROR',
      'F-WEB-ERROR',
      'F-WEB-MEMBERS-ROLE-OWNER',
      'F-WEB-MEMBERS-ROLE-MEMBER',
    ]);
    for (const c of codes) expect(catalog).toHaveProperty([c]);
  });

  it('satır eylemi: son sahip yok; kendi → ayrıl; sahip başkasını çıkarır; üye başkasını çıkaramaz', () => {
    const owner = m('OWNER', true);
    const member = m('MEMBER');
    expect(memberAction(owner, [owner, member], 'OWNER')).toBeNull();
    expect(memberAction(member, [owner, member], 'OWNER')).toBe('remove');
    const meMember = m('MEMBER', true);
    const otherOwner = m('OWNER');
    const other = m('MEMBER', false, 'x');
    const all = [otherOwner, meMember, other];
    expect(memberAction(meMember, all, 'MEMBER')).toBe('leave');
    expect(memberAction(other, all, 'MEMBER')).toBeNull();
    expect(memberAction(otherOwner, all, 'MEMBER')).toBeNull();
    const second = m('OWNER', false, 'o2');
    expect(memberAction(owner, [owner, second], 'OWNER')).toBe('leave');
    expect(memberAction(second, [owner, second], 'OWNER')).toBe('remove');
  });
});
