# Architecture: how tenant isolation works

## The request path

```
HTTP request
  │  Authorization: Bearer sk_...
  ▼
ApiKeyGuard (global)          key format check → SHA-256 → SELECT resolve_api_key(hash)
  │                           unknown / revoked / suspended tenant → 401 (always the same answer)
  ▼  req.tenantId (set only here)
TenantContextInterceptor      runs the handler inside TenantContext (AsyncLocalStorage)
  ▼
Service                       prisma.withCurrentTenant(tx => ...)
  ▼
PrismaService.withTenant      BEGIN; SELECT set_config('app.tenant_id', $1, true); ...; COMMIT
  ▼
PostgreSQL RLS                every row checked against current_setting('app.tenant_id')
```

## The four layers, and why each one is needed

### 1. Policies with USING and WITH CHECK

```sql
CREATE POLICY tenant_isolation ON projects
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

- `USING` filters what you can read, update and delete.
- `WITH CHECK` stops you from inserting a row for another tenant, or moving a row to another tenant.
- `NULLIF(..., '')` + `current_setting(..., true)`: no tenant set means `NULL`, and `tenant_id = NULL` is never true.
  Forgetting to set the tenant gives **zero rows**, never all rows.

### 2. FORCE ROW LEVEL SECURITY

Without `FORCE`, the table owner ignores the policies. With it, only superusers and `BYPASSRLS` roles do.

### 3. A runtime role that cannot bypass RLS

The API connects with `APP_DATABASE_URL` as `app_user`: not superuser, no `BYPASSRLS`, owns nothing, and has only the
grants each migration gives it, table by table (no `ALTER DEFAULT PRIVILEGES`). `PrismaService` checks this at boot and
refuses to start otherwise. Migrations and admin scripts use the owner connection (`DATABASE_URL`).

### 4. Transaction-local tenant setting

`set_config('app.tenant_id', id, true)`: the `true` makes it local to the transaction. When it commits or rolls back,
the setting is gone, so the next request that gets this pooled connection starts with no tenant. That is why every tenant
query runs inside `withTenant()` (one transaction).

## Resolving the tenant: the chicken-and-egg problem

To know the tenant we must read `api_keys`, but `api_keys` is under RLS and we do not know the tenant yet.

Wrong answers: query as the owner (now the app holds an RLS-bypassing connection), or trust an `X-Tenant-Id` header.

This starter uses a narrow `SECURITY DEFINER` function:

```sql
CREATE FUNCTION resolve_api_key(p_key_hash bytea) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ ... $$;
ALTER FUNCTION resolve_api_key(bytea) OWNER TO tenant_resolver;
```

- `tenant_resolver` is `NOLOGIN`: nobody can connect as it.
- It may read only 3 columns of `api_keys` and 2 of `tenants`, through a SELECT policy that exists only for it.
- `app_user` can EXECUTE the function, and nothing else. It takes a hash and returns one tenant id or NULL.
- `search_path` is pinned, so nobody can hijack it with a look-alike object.

Use the same pattern for any other "find the tenant from X" lookup: a signed webhook's account id, a custom domain,
a session token.

## API keys

`sk_` + 32 random bytes (base64url). Only `SHA-256(key)` is stored, plus an 8-character prefix for display.
A slow password hash is not needed because the key is random (not guessable from a dictionary), and the fast hash keeps
the per-request lookup to one index probe. Issue and revoke with the CLI (`npm run tenants -- --help`).

## Where the tenant context lives in code

`TenantContext` wraps one `AsyncLocalStorage`. It survives every `await`, timer and `Promise.all` inside the request,
and two concurrent requests never see each other's tenant. Background jobs should call
`tenantContext.run(job.tenantId, () => ...)` with a tenant id they stored themselves, never one from job input a user
controls.

## What the tests prove

| Test file | Proves |
|---|---|
| `test/tenant-isolation.e2e-spec.ts` | Through the real `PrismaService`: no context = no rows; A cannot read, update, move, delete or insert B's rows; raw SQL is isolated; the setting does not leak after commit or rollback; 20 concurrent transactions never mix |
| `test/db-privileges.e2e-spec.ts` | Every table is listed with its exact grants; every `tenant_id` table has ENABLE + FORCE + a policy with USING and WITH CHECK; roles have safe attributes; definer functions have the right owner and pinned `search_path`; the app refuses an unsafe role |
| `test/api.e2e-spec.ts` | Over HTTP: 401 cases, revoked keys, suspended tenants, header spoofing, 404 (not 403) across tenants, `tenantId` in a body is rejected |
