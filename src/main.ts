import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { configureHttp } from './http.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv(); // fail fast, before any module starts
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureHttp(app, env);
  await app.listen(env.PORT);
}

await bootstrap();
