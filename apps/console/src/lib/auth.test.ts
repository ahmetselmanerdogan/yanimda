import { describe, expect, it, vi } from 'vitest';

/** T-020 dönüş: kod değişimi başarısız olsa da `?code&state` adreste kalmaz (yenilemede aynı kod tekrar denenmez). */
const callback = vi.fn<() => Promise<unknown>>();
vi.mock('oidc-client-ts', () => ({
  UserManager: class {
    signinRedirectCallback = callback;
    getUser = async () => null;
  },
  WebStorageStateStore: class {},
}));

describe('girişten dönüş adresi', () => {
  it('signinRedirectCallback hata verirse de code/state/session_state/iss silinir, diğer parametreler kalır', async () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: {
        origin: 'http://localhost:5173',
        pathname: '/',
        search: '?code=abc&state=xyz&session_state=s&iss=i&training=1',
      },
      sessionStorage: {},
      history: { replaceState },
    });
    callback.mockRejectedValueOnce(new Error('No matching state found in storage'));
    const { restoreSession } = await import('./auth');
    await expect(restoreSession()).rejects.toThrow();
    expect(replaceState).toHaveBeenCalledWith({}, '', '/?training=1');
    vi.unstubAllGlobals();
  });
});
