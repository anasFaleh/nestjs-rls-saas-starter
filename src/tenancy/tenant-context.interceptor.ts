import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { TenantRequest } from '../auth/api-key.guard.js';
import { TenantContext } from './tenant-context.js';

/**
 * Global interceptor: runs the route handler inside TenantContext for the tenant the guard resolved.
 * Guards run before interceptors, so `req.tenantId` is already trusted here. Public routes have none and run without.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(@Inject(TenantContext) private readonly tenantContext: TenantContext) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const tenantId = context.switchToHttp().getRequest<TenantRequest>().tenantId;
    if (!tenantId) return next.handle();
    // The handler is invoked on subscribe, so subscribing inside enter() runs it (and every await in it) in the context.
    return new Observable((subscriber) =>
      this.tenantContext.enter(tenantId, () => next.handle().subscribe(subscriber)),
    );
  }
}
