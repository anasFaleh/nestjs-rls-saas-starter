import { API_KEY_RE, extractApiKey, generateApiKey, hashApiKey } from './api-key.js';

describe('api keys', () => {
  it('generates 256-bit keys in the documented format, with a matching hash and prefix', () => {
    const k = generateApiKey();
    expect(k.key).toMatch(API_KEY_RE);
    expect(k.prefix).toBe(k.key.slice(0, 8));
    expect(Buffer.from(k.hash).equals(Buffer.from(hashApiKey(k.key)))).toBe(true);
    expect(k.hash).toHaveLength(32);
  });

  it('never generates the same key twice', () => {
    const keys = new Set(Array.from({ length: 1000 }, () => generateApiKey().key));
    expect(keys.size).toBe(1000);
  });

  it('extracts only a well-formed Bearer key', () => {
    const { key } = generateApiKey();
    expect(extractApiKey(`Bearer ${key}`)).toBe(key);
    expect(extractApiKey(`bearer   ${key}`)).toBe(key);
    expect(extractApiKey(undefined)).toBeNull();
    expect(extractApiKey('')).toBeNull();
    expect(extractApiKey(key)).toBeNull();
    expect(extractApiKey(`Basic ${key}`)).toBeNull();
    expect(extractApiKey(`Bearer ${key}x`)).toBeNull();
    expect(extractApiKey(`Bearer ${key} extra`)).toBeNull();
    expect(extractApiKey("Bearer sk_' OR 1=1 --")).toBeNull();
  });
});
