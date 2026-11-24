# AGENTS.md: rules for AI coding agents (and humans)

This is a multi-tenant NestJS API. Tenant isolation is enforced by PostgreSQL Row Level Security. Keep it that way.

## Non-negotiable rules

1. **Tenant data only through `PrismaService.withTenant(tenantId, fn)` or `withCurrentTenant(fn)`.** Never query a
   tenant-owned model on `this.prisma` directly.
2. **Never accept a tenant id from the client** (body, query, params, headers). The tenant comes from `TenantContext`,
   set by `ApiKeyGuard` + `TenantContextInterceptor`. Request schemas use zod `.strict()`.
3. **Every new tenant-owned table** (see `docs/adding-a-tenant-table.md`):
   `tenant_id uuid NOT NULL`, indexes start with `tenant_id`, explicit GRANTs to `app_user`, `ENABLE` + `FORCE` RLS, a
   `tenant_isolation` policy with `USING` and `WITH CHECK`, an entry in `test/db-privileges.e2e-spec.ts`, and
   cross-tenant tests (read / update / delete / insert).
4. **The app connects as `app_user` (`APP_DATABASE_URL`)**. Never give it the owner URL, `BYPASSRLS`, or table ownership.
   `DATABASE_URL` (owner) is for migrations, the CLI and test seeding only.
5. **Never edit an applied migration.** Every DB change is a new migration. Hand-written SQL (grants, RLS, functions):
   `npx prisma migrate dev --create-only --name <name>`, edit, then `npx prisma migrate dev`.
6. **Cross-tenant lookups** (find the tenant from a key/domain/webhook) use a narrow `SECURITY DEFINER` function owned by
   a `NOLOGIN` role with column-level grants and a pinned `search_path`. See `resolve_api_key` in the migrations.
7. Another tenant's row is **404**, never 403.
8. Secrets only in `.env` (gitignored). Error messages name variables, never values.

## Code conventions

- TypeScript strict, ESM with `moduleResolution: nodenext`: **relative imports end in `.js`**.
- Prisma 7, generated client in `src/generated/prisma` (never edit; `npx prisma generate` after schema changes).
- Use `@Inject(Token)` explicitly in constructors.
- Tests: Vitest. Unit tests next to code (`src/**/*.spec.ts`), DB/HTTP tests in `test/*.e2e-spec.ts`.

## Before you say "done"

```bash
npm run typecheck && npm run lint && npm run build && npm test && npm run test:e2e
```
