import { appPrisma, ownerClient } from './helpers.js';

/**
 * Audit of schema `public` for the runtime role. EVERY table must be listed in EXPECTED, so nobody can add a table
 * without deciding its privileges and its RLS explicitly. A new table that is missing here fails the first test.
 *
 *   privs: which of S(ELECT) I(NSERT) U(PDATE) D(ELETE) app_user has, and ONLY those.
 *   rls:   'tenant'  = has tenant_id: ENABLE + FORCE RLS + `tenant_isolation` policy with USING and WITH CHECK
 *          'tenants' = the tenants table itself (policy on id)
 *          'none'    = no RLS (a documented exception, e.g. a global lookup table)
 */
const EXPECTED: Record<string, { privs: string; rls: 'tenant' | 'tenants' | 'none' }> = {
  _prisma_migrations: { privs: '', rls: 'none' },
  tenants: { privs: 'S', rls: 'tenants' },
  api_keys: { privs: 'S', rls: 'tenant' },
  projects: { privs: 'SIUD', rls: 'tenant' },
};

/** SECURITY DEFINER functions: owner role, and whether app_user may call them. */
const DEFINER_FUNCTIONS = [{ name: 'resolve_api_key', owner: 'tenant_resolver' }];

interface Row {
  table: string;
  s: boolean;
  i: boolean;
  u: boolean;
  d: boolean;
  rls: boolean;
  forced: boolean;
  has_tenant_id: boolean;
  owner: string;
}

describe('db privileges: app_user on schema public', () => {
  const owner = ownerClient();
  afterAll(() => owner.$disconnect());

  const audit = () =>
    owner.$queryRaw<Row[]>`
      SELECT c.relname AS "table",
             has_table_privilege('app_user', c.oid, 'SELECT') AS s,
             has_table_privilege('app_user', c.oid, 'INSERT') AS i,
             has_table_privilege('app_user', c.oid, 'UPDATE') AS u,
             has_table_privilege('app_user', c.oid, 'DELETE') AS d,
             c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS has_tenant_id,
             pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY 1`;

  it('every table in schema public is in EXPECTED (and every entry exists)', async () => {
    expect((await audit()).map((r) => r.table).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('app_user has exactly the expected privileges on each table', async () => {
    for (const r of await audit()) {
      const got = `${r.s ? 'S' : ''}${r.i ? 'I' : ''}${r.u ? 'U' : ''}${r.d ? 'D' : ''}`;
      expect({ table: r.table, privs: got }).toEqual({ table: r.table, privs: EXPECTED[r.table]?.privs });
    }
  });

  it('app_user owns no table (an owner can bypass RLS)', async () => {
    for (const r of await audit())
      expect({ table: r.table, owner: r.owner }).not.toEqual({ table: r.table, owner: 'app_user' });
  });

  it('every table with tenant_id has ENABLE + FORCE RLS and a tenant_isolation policy with USING + WITH CHECK', async () => {
    const policies = await owner.$queryRaw<{ table: string; qual: string | null; check: string | null }[]>`
      SELECT tablename AS "table", qual, with_check AS "check"
      FROM pg_policies WHERE schemaname = 'public' AND policyname = 'tenant_isolation'`;
    for (const r of await audit()) {
      const e = EXPECTED[r.table];
      expect({ table: r.table, hasTenantId: r.has_tenant_id }).toEqual({
        table: r.table,
        hasTenantId: e?.rls === 'tenant',
      });
      if (e?.rls === 'none') {
        expect({ table: r.table, rls: r.rls }).toEqual({ table: r.table, rls: false });
        continue;
      }
      expect({ table: r.table, rls: r.rls, forced: r.forced }).toEqual({ table: r.table, rls: true, forced: true });
      const p = policies.find((x) => x.table === r.table);
      expect(p, `${r.table}: tenant_isolation policy`).toBeDefined();
      expect(p?.qual, `${r.table}: USING`).toContain('app.tenant_id');
      expect(p?.check, `${r.table}: WITH CHECK`).toContain('app.tenant_id');
    }
  });

  it('roles: app_user is a plain login role; tenant_resolver cannot log in; neither bypasses RLS', async () => {
    const roles = await owner.$queryRaw<
      { name: string; login: boolean; super: boolean; bypass: boolean; createrole: boolean; createdb: boolean }[]
    >`
      SELECT rolname AS name, rolcanlogin AS login, rolsuper AS super, rolbypassrls AS bypass, rolcreaterole AS createrole, rolcreatedb AS createdb
      FROM pg_roles WHERE rolname IN ('app_user', 'tenant_resolver') ORDER BY 1`;
    expect(roles).toEqual([
      { name: 'app_user', login: true, super: false, bypass: false, createrole: false, createdb: false },
      { name: 'tenant_resolver', login: false, super: false, bypass: false, createrole: false, createdb: false },
    ]);
  });

  it('SECURITY DEFINER functions have the right owner, a pinned search_path, and are callable only by app_user', async () => {
    for (const f of DEFINER_FUNCTIONS) {
      const rows = await owner.$queryRaw<
        { owner: string; definer: boolean; config: string[] | null; app: boolean; pub: boolean }[]
      >`
        SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
               has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
               EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE') AS pub
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ${f.name}`;
      expect(rows).toHaveLength(1);
      const r = rows[0]!;
      expect({ fn: f.name, owner: r.owner, definer: r.definer, app: r.app, pub: r.pub }).toEqual({
        fn: f.name,
        owner: f.owner,
        definer: true,
        app: true,
        pub: false,
      });
      expect(r.config ?? []).toContain('search_path=pg_catalog, pg_temp');
    }
  });

  it('the app refuses to start when APP_DATABASE_URL points at a role that bypasses RLS (e.g. the owner)', async () => {
    const unsafe = appPrisma(process.env.DATABASE_URL!);
    try {
      await expect(unsafe.onModuleInit()).rejects.toThrow(/Unsafe DB role/);
    } finally {
      await unsafe.$disconnect();
    }
  });
});
