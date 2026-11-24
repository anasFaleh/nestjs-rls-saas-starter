import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { generateApiKey } from '../auth/api-key.js';

/**
 * Tenant administration with the OWNER connection (DATABASE_URL): the runtime role cannot create tenants or keys.
 * The tables have FORCE RLS, so every write first sets `app.tenant_id` in its own transaction: the writes then
 * pass the policies even when the owner is not a superuser (managed Postgres).
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function validateName(raw: string | undefined, what: string): string {
  const name = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > 100 || CONTROL_CHARS.test(name)) {
    throw new Error(`${what}: 1-100 characters, no control characters`);
  }
  return name;
}

export interface IssuedKey {
  keyId: string;
  /** Full key: shown once, never stored. */
  key: string;
  prefix: string;
}

export interface CreatedTenant extends IssuedKey {
  tenantId: string;
}

type Owner = Pick<PrismaClient, '$transaction'>;

async function asTenant<T>(
  owner: Owner,
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

/** Creates a tenant and its first API key in ONE transaction. */
export async function createTenant(owner: Owner, name: string, keyName = 'default'): Promise<CreatedTenant> {
  const tenantId = randomUUID();
  const k = generateApiKey();
  return asTenant(owner, tenantId, async (tx) => {
    await tx.tenant.create({ data: { id: tenantId, name } });
    const row = await tx.apiKey.create({ data: { tenantId, name: keyName, prefix: k.prefix, keyHash: k.hash } });
    return { tenantId, keyId: row.id, key: k.key, prefix: k.prefix };
  });
}

export async function issueApiKey(owner: Owner, tenantId: string, keyName: string): Promise<IssuedKey> {
  const k = generateApiKey();
  return asTenant(owner, tenantId, async (tx) => {
    const row = await tx.apiKey.create({ data: { tenantId, name: keyName, prefix: k.prefix, keyHash: k.hash } });
    return { keyId: row.id, key: k.key, prefix: k.prefix };
  });
}

/** Returns false when the key does not exist for this tenant or is already revoked. */
export async function revokeApiKey(owner: Owner, tenantId: string, keyId: string): Promise<boolean> {
  return asTenant(owner, tenantId, async (tx) => {
    const res = await tx.apiKey.updateMany({ where: { id: keyId, revokedAt: null }, data: { revokedAt: new Date() } });
    return res.count === 1;
  });
}

export async function setTenantStatus(
  owner: Owner,
  tenantId: string,
  status: 'ACTIVE' | 'SUSPENDED',
): Promise<boolean> {
  return asTenant(owner, tenantId, async (tx) => {
    const res = await tx.tenant.updateMany({ where: { id: tenantId }, data: { status } });
    return res.count === 1;
  });
}
