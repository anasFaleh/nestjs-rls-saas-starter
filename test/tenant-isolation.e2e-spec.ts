import type { PrismaClient } from '../src/generated/prisma/client.js';
import type { CreatedTenant } from '../src/tenancy/tenant-admin.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { appPrisma, deleteTenants, ownerClient, seedTenants, unique } from './helpers.js';

/**
 * Cross-tenant tests at the DATABASE level, through the app's real PrismaService (role app_user).
 * For every tenant-owned table: tenant A cannot read, update, delete, or insert rows of tenant B.
 * Copy this file's pattern for every table you add (docs/adding-a-tenant-table.md).
 */
describe('Tenant isolation (RLS) through PrismaService', () => {
  const owner: PrismaClient = ownerClient();
  const app: PrismaService = appPrisma();
  let a: CreatedTenant;
  let b: CreatedTenant;
  let projectOfA: string;
  let projectOfB: string;

  beforeAll(async () => {
    await app.onModuleInit();
    [a, b] = (await seedTenants(owner, 2)) as [CreatedTenant, CreatedTenant];
    projectOfA = (
      await app.withTenant(a.tenantId, (tx) =>
        tx.project.create({ data: { tenantId: a.tenantId, name: unique('pa') } }),
      )
    ).id;
    projectOfB = (
      await app.withTenant(b.tenantId, (tx) =>
        tx.project.create({ data: { tenantId: b.tenantId, name: unique('pb') } }),
      )
    ).id;
  });

  afterAll(async () => {
    await deleteTenants(owner, [a, b]);
    await owner.$disconnect();
    await app.onModuleDestroy();
  });

  describe('no tenant context', () => {
    it('sees no rows in any tenant table', async () => {
      expect(await app.tenant.findMany()).toEqual([]);
      expect(await app.apiKey.findMany()).toEqual([]);
      expect(await app.project.findMany()).toEqual([]);
    });

    it('cannot insert (WITH CHECK fails on a NULL tenant)', async () => {
      await expect(app.project.create({ data: { tenantId: a.tenantId, name: unique('x') } })).rejects.toThrow(
        /row-level security/i,
      );
    });

    it('withCurrentTenant() outside a TenantContext throws instead of running unscoped', async () => {
      await expect(app.withCurrentTenant((tx) => tx.project.findMany())).rejects.toThrow(/No tenant context/);
    });
  });

  describe('projects', () => {
    it("READ: A sees only its own projects; B's id does not exist for A", async () => {
      const rows = await app.withTenant(a.tenantId, (tx) => tx.project.findMany());
      expect(rows.map((r) => r.id)).toEqual([projectOfA]);
      expect(await app.withTenant(a.tenantId, (tx) => tx.project.findUnique({ where: { id: projectOfB } }))).toBeNull();
    });

    it("UPDATE: A cannot update B's project (0 rows, B unchanged)", async () => {
      const res = await app.withTenant(a.tenantId, (tx) =>
        tx.project.updateMany({ where: { id: projectOfB }, data: { name: 'hacked' } }),
      );
      expect(res.count).toBe(0);
      const asB = await app.withTenant(b.tenantId, (tx) => tx.project.findUniqueOrThrow({ where: { id: projectOfB } }));
      expect(asB.name).not.toBe('hacked');
    });

    it('UPDATE: A cannot move its own project to B (WITH CHECK)', async () => {
      await expect(
        app.withTenant(a.tenantId, (tx) =>
          tx.project.update({ where: { id: projectOfA }, data: { tenantId: b.tenantId } }),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it("DELETE: A cannot delete B's project (0 rows, B still there)", async () => {
      const res = await app.withTenant(a.tenantId, (tx) => tx.project.deleteMany({ where: { id: projectOfB } }));
      expect(res.count).toBe(0);
      expect(
        await app.withTenant(b.tenantId, (tx) => tx.project.findUnique({ where: { id: projectOfB } })),
      ).not.toBeNull();
    });

    it("INSERT: A cannot insert a row carrying B's tenant_id", async () => {
      await expect(
        app.withTenant(a.tenantId, (tx) => tx.project.create({ data: { tenantId: b.tenantId, name: unique('evil') } })),
      ).rejects.toThrow(/row-level security/i);
    });

    it('raw SQL is isolated too (RLS lives in the database, not in the ORM)', async () => {
      const rows = await app.withTenant(a.tenantId, (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM projects`);
      expect(rows.map((r) => r.id)).toEqual([projectOfA]);
    });
  });

  describe('tenants and api_keys', () => {
    it('READ: A sees only its own tenant row and its own keys', async () => {
      const [tenants, keys] = await app.withTenant(a.tenantId, (tx) =>
        Promise.all([tx.tenant.findMany(), tx.apiKey.findMany()]),
      );
      expect(tenants.map((t) => t.id)).toEqual([a.tenantId]);
      expect(keys.map((k) => k.id)).toEqual([a.keyId]);
    });

    it('UPDATE / DELETE / INSERT are not even granted to the runtime role', async () => {
      await expect(
        app.withTenant(a.tenantId, (tx) => tx.tenant.updateMany({ where: { id: a.tenantId }, data: { name: 'x' } })),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        app.withTenant(a.tenantId, (tx) => tx.apiKey.deleteMany({ where: { id: b.keyId } })),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        app.withTenant(a.tenantId, (tx) =>
          tx.apiKey.create({ data: { tenantId: a.tenantId, name: 'x', prefix: 'sk_x', keyHash: new Uint8Array(32) } }),
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe('the tenant setting never leaks', () => {
    it('is gone after the transaction (pooled connections are reused)', async () => {
      await app.withTenant(a.tenantId, (tx) => tx.project.findMany());
      expect(await app.project.findMany()).toEqual([]);
      const [row] = await app.$queryRaw<
        { v: string | null }[]
      >`SELECT NULLIF(current_setting('app.tenant_id', true), '') AS v`;
      expect(row?.v ?? null).toBeNull();
    });

    it('is gone after a transaction that failed', async () => {
      await expect(app.withTenant(a.tenantId, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
      expect(await app.project.findMany()).toEqual([]);
    });

    it('many concurrent transactions of two tenants never mix', async () => {
      const runs = Array.from({ length: 20 }, (_, i) => {
        const t = i % 2 === 0 ? a : b;
        return app.withTenant(t.tenantId, async (tx) => ({
          expected: t.tenantId,
          seen: (await tx.tenant.findMany()).map((r) => r.id),
        }));
      });
      for (const r of await Promise.all(runs)) expect(r.seen).toEqual([r.expected]);
    });

    it('rejects a malformed tenant id before touching the database', async () => {
      await expect(app.withTenant("x' OR 1=1 --", (tx) => tx.project.findMany())).rejects.toThrow('Invalid tenantId');
    });
  });
});
