import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { hashApiKey } from './api-key.js';

@Injectable()
export class ApiKeyService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * key -> tenant id, or null (unknown key, revoked key, suspended tenant).
   * Runs OUTSIDE any tenant transaction: RLS would hide every key. The SECURITY DEFINER function
   * resolve_api_key() is the only way the runtime role can look a key up (docs/architecture.md).
   */
  async resolveTenant(key: string): Promise<string | null> {
    const [row] = await this.prisma.$queryRaw<{ tenant_id: string | null }[]>`
      SELECT public.resolve_api_key(${hashApiKey(key)}) AS tenant_id`;
    return row?.tenant_id ?? null;
  }
}
