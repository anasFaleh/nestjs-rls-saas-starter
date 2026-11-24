import 'dotenv/config';

process.env.NODE_ENV ??= 'test';
if (!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL) {
  throw new Error('E2E tests need DATABASE_URL (owner) and APP_DATABASE_URL (app_user): copy .env.example to .env');
}
