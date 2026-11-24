import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { extractApiKey } from './api-key.js';
import { ApiKeyService } from './api-key.service.js';
import { IS_PUBLIC } from './public.decorator.js';

/** The request after authentication. `tenantId` is set ONLY by this guard. */
export interface TenantRequest extends Request {
  tenantId?: string;
}

/**
 * Global guard: secure by default. Resolves `Authorization: Bearer <api key>` to a tenant on the server side.
 * Every failure gets the same 401 (no hint whether the key exists, is revoked, or the tenant is suspended).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ApiKeyService) private readonly apiKeys: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<TenantRequest>();
    const key = extractApiKey(req.headers.authorization);
    const tenantId = key ? await this.apiKeys.resolveTenant(key) : null;
    if (!tenantId) throw new UnauthorizedException('Invalid or missing API key');
    req.tenantId = tenantId;
    return true;
  }
}
