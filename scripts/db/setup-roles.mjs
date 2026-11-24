// Creates (or updates) the database roles the app needs. Run with the OWNER/superuser connection BEFORE migrations:
//   npm run db:roles
// Idempotent and cross-platform (no psql needed). Reads DATABASE_URL and APP_DATABASE_URL from the environment / .env.
//
//   app_user         LOGIN, the API's runtime role. Not superuser, no BYPASSRLS, owns nothing -> RLS always applies.
//   tenant_resolver  NOLOGIN, owns the SECURITY DEFINER function resolve_api_key(). Never used to connect.
//
// If your migration role is NOT a superuser (managed Postgres), it must be a member of tenant_resolver so migrations can
// run `ALTER FUNCTION ... OWNER TO tenant_resolver`. This script grants that membership to the current user.
import 'dotenv/config';
import pg from 'pg';

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.APP_DATABASE_URL;
if (!ownerUrl || !appUrl) {
  console.error('DATABASE_URL and APP_DATABASE_URL must be set (see .env.example)');
  process.exit(1);
}

const app = new URL(appUrl);
const appRole = decodeURIComponent(app.username);
const appPassword = decodeURIComponent(app.password);
if (appRole !== 'app_user') {
  console.error('APP_DATABASE_URL must connect as "app_user" (the migrations grant privileges to that role)');
  process.exit(1);
}
if (appPassword.length < 12) {
  console.error('APP_DATABASE_URL: use a password of at least 12 characters');
  process.exit(1);
}

const client = new pg.Client({ connectionString: ownerUrl });
try {
  await client.connect();
  // Passed as a session setting so the password never appears inside the SQL text we send.
  await client.query("SELECT set_config('setup.app_password', $1, false)", [appPassword]);
  await client.query(`
    DO $$
    DECLARE
      is_super boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        EXECUTE format('CREATE ROLE app_user LOGIN PASSWORD %L', current_setting('setup.app_password'));
      ELSE
        EXECUTE format('ALTER ROLE app_user LOGIN PASSWORD %L', current_setting('setup.app_password'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_resolver') THEN
        CREATE ROLE tenant_resolver NOLOGIN;
      END IF;

      IF is_super THEN
        -- Reset the attributes in case the roles existed before with unsafe ones.
        -- (A non-superuser cannot set these attributes at all, so roles it created never have them.)
        ALTER ROLE app_user NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        ALTER ROLE tenant_resolver NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      ELSE
        -- Managed Postgres: migrations run \`ALTER FUNCTION ... OWNER TO tenant_resolver\`, which needs membership.
        EXECUTE format('GRANT tenant_resolver TO %I', current_user);
      END IF;
    END
    $$;`);
  // Verify instead of trusting: refuse to continue with an unsafe role.
  const { rows } = await client.query(
    `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
     FROM pg_roles WHERE rolname IN ('app_user', 'tenant_resolver')`,
  );
  for (const r of rows) {
    const unsafe = r.rolsuper || r.rolbypassrls || r.rolcreaterole || r.rolcreatedb;
    const loginWrong = r.rolname === 'tenant_resolver' ? r.rolcanlogin : !r.rolcanlogin;
    if (unsafe || loginWrong) throw new Error(`role ${r.rolname} has unsafe attributes; fix it as a superuser`);
  }
  await client.query("SELECT set_config('setup.app_password', '', false)");
  console.log('roles ok: app_user, tenant_resolver');
} catch (err) {
  // Print the message and code only: pg errors carry the failing statement in `where`, which can include the password.
  console.error(`setup-roles failed: ${err?.message ?? err}${err?.code ? ` (code ${err.code})` : ''}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
