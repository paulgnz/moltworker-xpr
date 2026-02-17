import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isDevMode, isE2ETestMode, extractJWT } from './middleware';
import type { MoltbotEnv } from '../types';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { createMockEnv } from '../test-utils';

describe('isDevMode', () => {
  it('returns true when DEV_MODE is "true"', () => {
    const env = createMockEnv({ DEV_MODE: 'true' });
    expect(isDevMode(env)).toBe(true);
  });

  it('returns false when DEV_MODE is undefined', () => {
    const env = createMockEnv();
    expect(isDevMode(env)).toBe(false);
  });

  it('returns false when DEV_MODE is "false"', () => {
    const env = createMockEnv({ DEV_MODE: 'false' });
    expect(isDevMode(env)).toBe(false);
  });

  it('returns false when DEV_MODE is any other value', () => {
    const env = createMockEnv({ DEV_MODE: 'yes' });
    expect(isDevMode(env)).toBe(false);
  });

  it('returns false when DEV_MODE is empty string', () => {
    const env = createMockEnv({ DEV_MODE: '' });
    expect(isDevMode(env)).toBe(false);
  });
});

describe('isE2ETestMode', () => {
  it('returns true when E2E_TEST_MODE is "true"', () => {
    const env = createMockEnv({ E2E_TEST_MODE: 'true' });
    expect(isE2ETestMode(env)).toBe(true);
  });

  it('returns false when E2E_TEST_MODE is undefined', () => {
    const env = createMockEnv();
    expect(isE2ETestMode(env)).toBe(false);
  });

  it('returns false when E2E_TEST_MODE is "false"', () => {
    const env = createMockEnv({ E2E_TEST_MODE: 'false' });
    expect(isE2ETestMode(env)).toBe(false);
  });

  it('returns false when E2E_TEST_MODE is any other value', () => {
    const env = createMockEnv({ E2E_TEST_MODE: 'yes' });
    expect(isE2ETestMode(env)).toBe(false);
  });
});

describe('extractJWT', () => {
  // Helper to create a mock context
  function createMockContext(options: {
    jwtHeader?: string;
    cookies?: string;
    authHeader?: string;
  }): Context<AppEnv> {
    const headers = new Headers();
    if (options.jwtHeader) {
      headers.set('CF-Access-JWT-Assertion', options.jwtHeader);
    }
    if (options.cookies) {
      headers.set('Cookie', options.cookies);
    }
    if (options.authHeader) {
      headers.set('Authorization', options.authHeader);
    }

    return {
      req: {
        header: (name: string) => headers.get(name),
        raw: {
          headers,
        },
      },
    } as unknown as Context<AppEnv>;
  }

  it('extracts JWT from CF-Access-JWT-Assertion header', () => {
    const jwt = 'header.payload.signature';
    const c = createMockContext({ jwtHeader: jwt });
    expect(extractJWT(c)).toEqual({ token: jwt, source: 'cf-access' });
  });

  it('extracts JWT from CF_Authorization cookie', () => {
    const jwt = 'cookie.payload.signature';
    const c = createMockContext({ cookies: `CF_Authorization=${jwt}` });
    expect(extractJWT(c)).toEqual({ token: jwt, source: 'cf-access' });
  });

  it('extracts JWT from CF_Authorization cookie with other cookies', () => {
    const jwt = 'cookie.payload.signature';
    const c = createMockContext({
      cookies: `other=value; CF_Authorization=${jwt}; another=test`,
    });
    expect(extractJWT(c)).toEqual({ token: jwt, source: 'cf-access' });
  });

  it('prefers CF Access header over cookie', () => {
    const headerJwt = 'header.jwt.token';
    const cookieJwt = 'cookie.jwt.token';
    const c = createMockContext({
      jwtHeader: headerJwt,
      cookies: `CF_Authorization=${cookieJwt}`,
    });
    expect(extractJWT(c)).toEqual({ token: headerJwt, source: 'cf-access' });
  });

  it('returns null when no JWT present', () => {
    const c = createMockContext({});
    expect(extractJWT(c)).toBeNull();
  });

  it('returns null when cookie header exists but no relevant cookie', () => {
    const c = createMockContext({ cookies: 'other=value; session=abc123' });
    expect(extractJWT(c)).toBeNull();
  });

  it('extracts wallet JWT from moltbot_session cookie', () => {
    const jwt = 'wallet.payload.signature';
    const c = createMockContext({ cookies: `moltbot_session=${jwt}` });
    expect(extractJWT(c)).toEqual({ token: jwt, source: 'wallet' });
  });

  it('extracts wallet JWT from Authorization Bearer header', () => {
    const jwt = 'bearer.payload.signature';
    const c = createMockContext({ authHeader: `Bearer ${jwt}` });
    expect(extractJWT(c)).toEqual({ token: jwt, source: 'wallet' });
  });

  it('handles cookie with whitespace', () => {
    const jwt = 'spaced.payload.signature';
    const c = createMockContext({ cookies: `  CF_Authorization=${jwt}  ` });
    expect(extractJWT(c)).toEqual({ token: jwt, source: 'cf-access' });
  });
});

describe('createAuthMiddleware', () => {
  // Import the function dynamically to allow mocking
  let createAuthMiddleware: typeof import('./middleware').createAuthMiddleware;

  beforeEach(async () => {
    vi.resetModules();
    const module = await import('./middleware');
    createAuthMiddleware = module.createAuthMiddleware;
  });

  // Helper to create a mock context with full implementation
  function createFullMockContext(options: {
    env?: Partial<MoltbotEnv>;
    jwtHeader?: string;
    cookies?: string;
  }): {
    c: Context<AppEnv>;
    jsonMock: ReturnType<typeof vi.fn>;
    htmlMock: ReturnType<typeof vi.fn>;
    redirectMock: ReturnType<typeof vi.fn>;
    setMock: ReturnType<typeof vi.fn>;
  } {
    const headers = new Headers();
    if (options.jwtHeader) {
      headers.set('CF-Access-JWT-Assertion', options.jwtHeader);
    }
    if (options.cookies) {
      headers.set('Cookie', options.cookies);
    }

    const jsonMock = vi.fn().mockReturnValue(new Response());
    const htmlMock = vi.fn().mockReturnValue(new Response());
    const redirectMock = vi.fn().mockReturnValue(new Response());
    const setMock = vi.fn();

    const c = {
      req: {
        header: (name: string) => headers.get(name),
        raw: { headers },
      },
      env: createMockEnv(options.env),
      json: jsonMock,
      html: htmlMock,
      redirect: redirectMock,
      set: setMock,
    } as unknown as Context<AppEnv>;

    return { c, jsonMock, htmlMock, redirectMock, setMock };
  }

  it('skips auth and sets dev user when DEV_MODE is true', async () => {
    const { c, setMock } = createFullMockContext({ env: { DEV_MODE: 'true' } });
    const middleware = createAuthMiddleware({ type: 'json' });
    const next = vi.fn();

    await middleware(c, next);

    expect(next).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith('accessUser', {
      email: 'dev@localhost',
      name: 'Dev User',
    });
  });

  it('skips auth and sets dev user when E2E_TEST_MODE is true', async () => {
    const { c, setMock } = createFullMockContext({ env: { E2E_TEST_MODE: 'true' } });
    const middleware = createAuthMiddleware({ type: 'json' });
    const next = vi.fn();

    await middleware(c, next);

    expect(next).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith('accessUser', {
      email: 'dev@localhost',
      name: 'Dev User',
    });
  });

  it('returns 503 JSON error when no auth method configured', async () => {
    const { c, jsonMock } = createFullMockContext({ env: {} });
    const middleware = createAuthMiddleware({ type: 'json' });
    const next = vi.fn();

    await middleware(c, next);

    expect(next).not.toHaveBeenCalled();
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'No authentication method configured' }),
      503,
    );
  });

  it('returns 503 HTML error when no auth method configured', async () => {
    const { c, htmlMock } = createFullMockContext({ env: {} });
    const middleware = createAuthMiddleware({ type: 'html' });
    const next = vi.fn();

    await middleware(c, next);

    expect(next).not.toHaveBeenCalled();
    expect(htmlMock).toHaveBeenCalledWith(
      expect.stringContaining('Authentication Not Configured'),
      503,
    );
  });

  it('returns 401 JSON error when JWT is missing (CF Access)', async () => {
    const { c, jsonMock } = createFullMockContext({
      env: { CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud123' },
    });
    const middleware = createAuthMiddleware({ type: 'json' });
    const next = vi.fn();

    await middleware(c, next);

    expect(next).not.toHaveBeenCalled();
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ error: 'Unauthorized' }), 401);
  });

  it('returns wallet login signal when JWT is missing (wallet auth, HTML)', async () => {
    const { c, jsonMock } = createFullMockContext({
      env: { XPR_OWNER_ACCOUNT: 'testowner' },
    });
    const middleware = createAuthMiddleware({ type: 'html' });
    const next = vi.fn();

    await middleware(c, next);

    expect(next).not.toHaveBeenCalled();
    expect(jsonMock).toHaveBeenCalledWith({ _walletLoginRequired: true }, 401);
  });

  it('redirects when JWT is missing and redirectOnMissing is true (CF Access)', async () => {
    const { c, redirectMock } = createFullMockContext({
      env: { CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud123' },
    });
    const middleware = createAuthMiddleware({ type: 'html', redirectOnMissing: true });
    const next = vi.fn();

    await middleware(c, next);

    expect(next).not.toHaveBeenCalled();
    expect(redirectMock).toHaveBeenCalledWith('https://team.cloudflareaccess.com', 302);
  });
});
