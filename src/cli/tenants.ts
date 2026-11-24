/**
 * Tenant admin CLI (OWNER connection, DATABASE_URL). Build first: `npm run build`.
 *
 *   node dist/cli/tenants.js create --name "Acme Inc"
 *   node dist/cli/tenants.js add-key <tenantId> --name "ci"
 *   node dist/cli/tenants.js revoke-key <tenantId> <keyId>
 *   node dist/cli/tenants.js suspend <tenantId>
 *   node dist/cli/tenants.js activate <tenantId>
 *
 * A new API key is printed ONCE. Only its SHA-256 is stored, so it cannot be shown again.
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { UUID_RE } from '../tenancy/tenant-context.js';
import { createTenant, issueApiKey, revokeApiKey, setTenantStatus, validateName } from '../tenancy/tenant-admin.js';

const USAGE = `Usage:
  tenants create --name "<tenant name>"
  tenants add-key <tenantId> --name "<key name>"
  tenants revoke-key <tenantId> <keyId>
  tenants suspend <tenantId>
  tenants activate <tenantId>`;

const uuid = (v: string | undefined, what: string): string => {
  if (!v || !UUID_RE.test(v)) throw new Error(`${what}: a UUID is required`);
  return v;
};

const KEY_WARNING = 'Store this key now (e.g. in your password manager). It will NOT be shown again.';

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { name: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  const [command, a, b] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (owner connection, see .env.example)');
  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    switch (command) {
      case 'create': {
        const t = await createTenant(owner, validateName(values.name, '--name'));
        console.log(`tenant  ${t.tenantId}\nkey id  ${t.keyId}\napi key ${t.key}\n\n${KEY_WARNING}`);
        return 0;
      }
      case 'add-key': {
        const k = await issueApiKey(owner, uuid(a, 'tenantId'), validateName(values.name, '--name'));
        console.log(`key id  ${k.keyId}\napi key ${k.key}\n\n${KEY_WARNING}`);
        return 0;
      }
      case 'revoke-key': {
        const ok = await revokeApiKey(owner, uuid(a, 'tenantId'), uuid(b, 'keyId'));
        console.log(ok ? 'revoked' : 'not found (or already revoked)');
        return ok ? 0 : 1;
      }
      case 'suspend':
      case 'activate': {
        const ok = await setTenantStatus(owner, uuid(a, 'tenantId'), command === 'suspend' ? 'SUSPENDED' : 'ACTIVE');
        console.log(ok ? `tenant ${command === 'suspend' ? 'suspended' : 'activated'}` : 'tenant not found');
        return ok ? 0 : 1;
      }
      default:
        console.log(USAGE);
        return 1;
    }
  } finally {
    await owner.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
