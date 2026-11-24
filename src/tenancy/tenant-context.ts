import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MissingTenantContextError extends Error {
  constructor() {
    super('No tenant context: the call must run inside TenantContext.run(tenantId, fn)');
    this.name = 'MissingTenantContextError';
  }
}

/** ONE storage for the whole process. Only TenantContext touches it. */
const storage = new AsyncLocalStorage<{ readonly tenantId: string }>();

/**
 * The current tenant of a request / job, carried through every `await` by AsyncLocalStorage.
 *
 * Set it ONLY from trusted server-side resolution (an API key, a session, a signed webhook...),
 * never from a header, body or query value the client chose.
 */
@Injectable()
export class TenantContext {
  /** Runs `fn` with `tenantId` as the current tenant. Nesting is allowed only for the same tenant. */
  enter<T>(tenantId: string, fn: () => T): T {
    if (!UUID_RE.test(tenantId)) throw new Error('Invalid tenantId');
    const current = storage.getStore();
    if (current) {
      if (current.tenantId.toLowerCase() !== tenantId.toLowerCase()) {
        throw new Error('Tenant context already set to a different tenant');
      }
      return fn();
    }
    return storage.run({ tenantId }, fn);
  }

  /** Promise-returning variant of enter(): errors become rejections. */
  run<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return this.enter(tenantId, fn);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  getTenantId(): string | undefined {
    return storage.getStore()?.tenantId;
  }

  requireTenantId(): string {
    const id = storage.getStore()?.tenantId;
    if (!id) throw new MissingTenantContextError();
    return id;
  }
}
