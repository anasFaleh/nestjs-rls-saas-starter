# Adding a tenant-owned table safely

Example: an `invoices` table that belongs to a tenant.

## 1. Model

```prisma
model Invoice {
  id        String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId  String   @map("tenant_id") @db.Uuid
  number    String
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, number])        // uniqueness is per tenant
  @@index([tenantId, createdAt])      // indexes START with tenant_id
  @@map("invoices")
}
```

Add `invoices Invoice[]` to `Tenant`.

## 2. Migration: generated part + hand-written part

```bash
npx prisma migrate dev --create-only --name invoices
```

Open the new `migration.sql` and append:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoices TO app_user;   -- only what the API needs

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.invoices
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

Then `npx prisma migrate dev` and `npx prisma generate`.

Tip: think about each privilege. Append-only history (audit logs, ledger lines) should get `SELECT, INSERT` only.

## 3. Register it in the privilege audit

`test/db-privileges.e2e-spec.ts`:

```ts
invoices: { privs: 'SIUD', rls: 'tenant' },
```

Until you do, the audit fails. That is on purpose.

## 4. Cross-tenant tests

Copy the `projects` block of `test/tenant-isolation.e2e-spec.ts` for `invoices`: read, update, delete, insert with
another tenant's id. If the table has an HTTP API, copy the 404 tests from `test/api.e2e-spec.ts`.

## 5. Service code

```ts
list() {
  return this.prisma.withCurrentTenant((tx) => tx.invoice.findMany());
}
create(input: CreateInvoiceInput) {
  const tenantId = this.tenantContext.requireTenantId();
  return this.prisma.withCurrentTenant((tx) => tx.invoice.create({ data: { ...input, tenantId } }));
}
```

Rules:
- Every query on tenant data goes through `withTenant` / `withCurrentTenant`. Never call `this.prisma.invoice...` directly
  (it would see nothing, which hides the bug until production).
- Never take `tenantId` from the request body, query, or headers. Use `.strict()` zod schemas so unknown keys are rejected.
- One `withCurrentTenant` per unit of work. Do slow I/O (HTTP calls, emails) outside it, not inside the transaction.
- Not found and "belongs to another tenant" are the same thing: 404.

## Checklist

- [ ] `tenant_id uuid NOT NULL` with FK to `tenants`
- [ ] composite indexes / uniques start with `tenant_id`
- [ ] explicit GRANTs to `app_user` (minimum needed)
- [ ] `ENABLE` + `FORCE` RLS, policy with `USING` + `WITH CHECK`
- [ ] entry in `EXPECTED` of `test/db-privileges.e2e-spec.ts`
- [ ] cross-tenant tests (read / update / delete / insert)
- [ ] `npm run typecheck && npm test && npm run test:e2e`
