import { loadEnv } from './env.js';

const base = { APP_DATABASE_URL: 'postgresql://app_user:secret-password@localhost:5434/db' };

describe('loadEnv', () => {
  it('applies defaults', () => {
    expect(loadEnv(base)).toEqual({ ...base, NODE_ENV: 'development', PORT: 3000, TRUST_PROXY_HOPS: 0 });
  });

  it('coerces numbers', () => {
    expect(loadEnv({ ...base, PORT: '8080', TRUST_PROXY_HOPS: '1' })).toMatchObject({
      PORT: 8080,
      TRUST_PROXY_HOPS: 1,
    });
  });

  it('fails on missing or invalid values, naming the variable but never the value', () => {
    expect(() => loadEnv({})).toThrow(/APP_DATABASE_URL/);
    expect(() => loadEnv({ ...base, PORT: '99999' })).toThrow(/PORT/);
    try {
      loadEnv({ APP_DATABASE_URL: 'mysql://user:TOP-SECRET@h/db' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/APP_DATABASE_URL: must be a postgresql:\/\/ URL/);
      expect((err as Error).message).not.toContain('TOP-SECRET');
    }
  });
});
