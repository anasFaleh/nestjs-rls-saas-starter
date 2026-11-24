-- Tenant isolation (hand-written, created with `prisma migrate dev --create-only`).
-- Needs the roles app_user and tenant_resolver: `npm run db:roles` creates them (roles live outside migrations,
-- because they are cluster-wide and carry a password).

-- 1. Runtime role privileges: explicit per table, no ALTER DEFAULT PRIVILEGES.
--    A new table gets NOTHING until its migration grants it (test/db-privileges.e2e-spec.ts enforces the list).
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT ON public.tenants TO app_user;   -- tenants are created/suspended by the owner (CLI), not by the API
GRANT SELECT ON public.api_keys TO app_user;  -- keys are issued by the owner (CLI); the API only resolves them
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO app_user;

-- 2. Row Level Security. FORCE = applies to the table owner too (unless superuser).
--    app.tenant_id is set per transaction by PrismaService.withTenant(); unset/empty = NULL = no rows.
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.tenants
  USING      (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.api_keys
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.projects
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 3. API key -> tenant resolution. Chicken and egg: before we know the tenant, RLS shows no key.
--    Answer: a narrow SECURITY DEFINER function owned by tenant_resolver (NOLOGIN), which can read ONLY the columns
--    it needs, through a SELECT policy that exists only for that role. The API can call the function, nothing else.
GRANT USAGE ON SCHEMA public TO tenant_resolver;
GRANT SELECT (tenant_id, key_hash, revoked_at) ON public.api_keys TO tenant_resolver;
GRANT SELECT (id, status) ON public.tenants TO tenant_resolver;

CREATE POLICY api_keys_tenant_resolver_select ON public.api_keys
  FOR SELECT TO tenant_resolver USING (true);
CREATE POLICY tenants_tenant_resolver_select ON public.tenants
  FOR SELECT TO tenant_resolver USING (true);

CREATE FUNCTION public.resolve_api_key(p_key_hash bytea)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT k.tenant_id
  FROM public.api_keys k
  JOIN public.tenants t ON t.id = k.tenant_id
  WHERE k.key_hash = p_key_hash
    AND k.revoked_at IS NULL
    AND t.status = 'ACTIVE'
  LIMIT 1
$$;

-- A new owner needs CREATE on the schema (checked for non-superusers, e.g. managed Postgres). Granted only for the
-- ownership change, then revoked: tenant_resolver must not be able to create objects.
GRANT CREATE ON SCHEMA public TO tenant_resolver;
ALTER FUNCTION public.resolve_api_key(bytea) OWNER TO tenant_resolver;
REVOKE CREATE ON SCHEMA public FROM tenant_resolver;
REVOKE ALL ON FUNCTION public.resolve_api_key(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_api_key(bytea) TO app_user;
