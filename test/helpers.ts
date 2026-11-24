import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppModule } from '../src/app.module.js';
import { loadEnv } from '../src/config/env.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { configureHttp } from '../src/http.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TenantContext } from '../src/tenancy/tenant-context.js';
import { createTenant, type CreatedTenant } from '../src/tenancy/tenant-admin.js';

/**
 * OWNER connection: seeding and cleanup only. Do not use it to assert on tenant rows: on managed Postgres the owner is
 * not a superuser, so FORCE RLS hides rows from it too. Read through appPrisma().withTenant() instead.
 */
export const ownerClient = (): PrismaClient =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

/** The app's real PrismaService (runtime role app_user, RLS applies). Call onModuleInit() before use. */
export const appPrisma = (url = process.env.APP_DATABASE_URL!): PrismaService =>
  new PrismaService(new TenantContext(), { APP_DATABASE_URL: url });

/** Unique names so test files can run against a dev database that already has data. */
export const unique = (label: string): string =>
  `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export async function seedTenants(owner: PrismaClient, count: number): Promise<CreatedTenant[]> {
  const out: CreatedTenant[] = [];
  for (let i = 0; i < count; i++) out.push(await createTenant(owner, unique(`test-tenant-${i}`)));
  return out;
}

export async function deleteTenants(owner: PrismaClient, tenants: { tenantId: string }[]): Promise<void> {
  // Per tenant with app.tenant_id set, so it also works when the owner is not a superuser (FORCE RLS).
  // api_keys and projects go with ON DELETE CASCADE.
  for (const { tenantId } of tenants) {
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  }
}

/** The full Nest app with the same HTTP config as main.ts. */
export async function createHttpApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureHttp(app, loadEnv());
  await app.init();
  return app;
}
