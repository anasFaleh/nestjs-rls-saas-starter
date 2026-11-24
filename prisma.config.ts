import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma CLI (migrate, generate) uses the OWNER connection. The app never does: it uses APP_DATABASE_URL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
