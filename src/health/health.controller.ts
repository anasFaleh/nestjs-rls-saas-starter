import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';

const PROBE_TIMEOUT_MS = 2000;

const withTimeout = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS).unref()),
  ]);

@Public()
@Controller()
export class HealthController {
  constructor(@Inject(PrismaService) private readonly prisma: Pick<PrismaService, '$queryRaw'>) {}

  /** Liveness: the process answers. Touches nothing. */
  @Get('healthz')
  healthz(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: the database answers. No versions, hosts or error text in the body. */
  @Get('readyz')
  async readyz(): Promise<{ status: 'ok' }> {
    const db = await withTimeout(this.prisma.$queryRaw`SELECT 1`).then(
      () => true,
      () => false,
    );
    if (!db) throw new ServiceUnavailableException({ status: 'unavailable' });
    return { status: 'ok' };
  }
}
