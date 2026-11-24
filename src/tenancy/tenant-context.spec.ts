import { MissingTenantContextError, TenantContext } from './tenant-context.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('TenantContext (AsyncLocalStorage)', () => {
  const ctx = new TenantContext();

  it('getTenantId inside run', async () => {
    expect(await ctx.run(A, async () => ctx.getTenantId())).toBe(A);
  });

  it('survives await, setTimeout and Promise.all', async () => {
    const seen = await ctx.run(A, async () => {
      await Promise.resolve();
      const t = await new Promise<string | undefined>((res) => setTimeout(() => res(ctx.getTenantId()), 5));
      const all = await Promise.all([sleep(3).then(() => ctx.getTenantId()), (async () => ctx.getTenantId())()]);
      return [t, ...all];
    });
    expect(seen).toEqual([A, A, A]);
  });

  it('concurrent runs do not mix tenants', async () => {
    const [x, y] = await Promise.all([
      ctx.run(A, async () => {
        await sleep(10);
        return ctx.requireTenantId();
      }),
      ctx.run(B, async () => {
        await sleep(1);
        return ctx.requireTenantId();
      }),
    ]);
    expect([x, y]).toEqual([A, B]);
  });

  it('requireTenantId outside run throws MissingTenantContextError', () => {
    expect(() => ctx.requireTenantId()).toThrow(MissingTenantContextError);
    expect(ctx.getTenantId()).toBeUndefined();
  });

  it('invalid UUID throws', async () => {
    await expect(ctx.run('not-a-uuid', async () => 1)).rejects.toThrow('Invalid tenantId');
  });

  it('nested run with a different tenant throws', async () => {
    await expect(ctx.run(A, () => ctx.run(B, async () => 1))).rejects.toThrow(/different tenant/);
  });

  it('nested run with the same tenant is OK', async () => {
    expect(await ctx.run(A, () => ctx.run(A, async () => ctx.getTenantId()))).toBe(A);
  });

  it('enter() runs synchronously and validates the id', () => {
    expect(ctx.enter(A, () => ctx.getTenantId())).toBe(A);
    expect(() => ctx.enter('nope', () => 1)).toThrow('Invalid tenantId');
  });

  it('context is gone after run resolves', async () => {
    await ctx.run(A, async () => 1);
    expect(ctx.getTenantId()).toBeUndefined();
  });
});
