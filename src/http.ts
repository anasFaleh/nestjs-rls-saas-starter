import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Env } from './config/env.js';

/** HTTP settings shared by main.ts and the e2e tests, so tests exercise the real configuration. */
export function configureHttp(app: NestExpressApplication, env: Pick<Env, 'TRUST_PROXY_HOPS'>): void {
  app.disable('x-powered-by');
  // Behind N trusted proxies, req.ip is the real client from X-Forwarded-For. Never trust more hops than you have.
  if (env.TRUST_PROXY_HOPS > 0) app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.useBodyParser('json', { limit: '100kb' });
  app.enableShutdownHooks();
}
