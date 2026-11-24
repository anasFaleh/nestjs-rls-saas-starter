import { z } from 'zod';

/**
 * Typed, validated environment. Loaded once at boot; the app refuses to start on a bad value.
 * Error messages name the variable and the rule, never the value (no secrets in logs).
 */
const postgresUrl = z
  .string()
  .trim()
  .min(1)
  .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgresql:// URL');

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Reverse proxies in front of the app (Express "trust proxy"). 0 = none. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /** Runtime connection (non-owner role `app_user`). */
  APP_DATABASE_URL: postgresUrl,
});

export type Env = z.infer<typeof EnvSchema>;

/** DI token for the validated Env. */
export const ENV = Symbol('ENV');

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment (see .env.example): ${problems.join('; ')}`);
  }
  return parsed.data;
}
