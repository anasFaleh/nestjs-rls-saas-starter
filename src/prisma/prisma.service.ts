import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { ENV, type Env } from '../config/env.js';
import { TenantContext, UUID_RE } from '../tenancy/tenant-context.js';

/**
 * Pool of the runtime connection. `max` 10 is the pg default, written down so it is a decision.
 * `keepAlive`: a connection whose peer vanished (DB restart, NAT reset) is detected by the OS instead of
 * staying "alive" in the pool until a query tries it.
 */
export const APP_POOL_OPTIONS = { max: 10, keepAlive: true, keepAliveInitialDelayMillis: 10_000 } as const;

/** One attempt per pooled connection + 1: after a DB restart every idle connection may be dead. */
export const START_ATTEMPTS = APP_POOL_OPTIONS.max + 1;
/** Wait before retry n (1-based); past the end of the list, the last value. */
export const START_BACKOFF_MS = [100, 200, 400, 800, 1000] as const;
const TX_START_ERROR_CODES = new Set(['P2028', 'P2039', 'P1017']);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const isTxStartError = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && TX_START_ERROR_CODES.has(err.code);

export type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(
    @Inject(TenantContext) private readonly tenantContext: TenantContext,
    @Inject(ENV) env: Pick<Env, 'APP_DATABASE_URL'>,
  ) {
    super({ adapter: new PrismaPg({ connectionString: env.APP_DATABASE_URL, ...APP_POOL_OPTIONS }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.assertSafeRole();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Runs `fn` in a transaction where Row Level Security sees only `tenantId`.
   * `set_config(..., true)` is transaction-local: it is gone at COMMIT/ROLLBACK, so a pooled
   * connection never carries a tenant into the next request.
   */
  async withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(tenantId)) throw new Error('Invalid tenantId');
    // A transaction that could not even START (a pooled connection died while idle) ran nothing of `fn`,
    // so retrying on a fresh connection is safe. Once `fn` has begun, errors are never retried here.
    for (let attempt = 1; ; attempt++) {
      let began = false;
      try {
        return await this.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          began = true;
          return fn(tx);
        });
      } catch (err) {
        if (began || attempt >= START_ATTEMPTS || !isTxStartError(err)) throw err;
        this.logger.warn(`event=tx_start_retry attempt=${attempt} code=${(err as { code: string }).code}`);
        await sleep(START_BACKOFF_MS[Math.min(attempt, START_BACKOFF_MS.length) - 1] ?? 1000);
      }
    }
  }

  /** withTenant() for the tenant of the current request/job (TenantContext). Throws if there is none. */
  async withCurrentTenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.withTenant(this.tenantContext.requireTenantId(), fn);
  }

  /** Refuse to start when connected as a role that would bypass RLS (superuser, BYPASSRLS, or a table owner). */
  private async assertSafeRole(): Promise<void> {
    const [row] = await this.$queryRaw<{ is_super: boolean; bypass_rls: boolean; owned_tables: number }[]>`
      SELECT r.rolsuper     AS is_super,
             r.rolbypassrls AS bypass_rls,
             (SELECT count(*)::int FROM pg_tables
               WHERE schemaname = 'public' AND tableowner = current_user) AS owned_tables
      FROM pg_roles r
      WHERE r.rolname = current_user`;
    if (!row || row.is_super || row.bypass_rls || row.owned_tables > 0) {
      throw new Error(
        `Unsafe DB role for the app: ${JSON.stringify(row ?? null)}. APP_DATABASE_URL must use the non-owner role app_user.`,
      );
    }
  }
}
