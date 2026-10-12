import "server-only";
import { z } from "zod";

/**
 * Server-only configuration, validated once. Nothing here is ever sent to the
 * browser: no NEXT_PUBLIC_ variables are used anywhere in the app.
 */
const schema = z.object({
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  AUTH_GOOGLE_ID: z.string().min(1),
  AUTH_GOOGLE_SECRET: z.string().min(1),
  /** 32 random bytes, base64: encrypts OAuth tokens at rest. */
  TOKEN_ENC_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "TOKEN_ENC_KEY must be 32 bytes, base64"),
  GEMINI_API_KEY: z.string().optional(),
  /** Any Gemini model id, e.g. gemini-2.5-flash; swap it without code changes. */
  GEMINI_MODEL: z.string().optional(),
  DATABASE_PATH: z.string().default("./data/rabbithole.db"),
  /** YouTube Data API daily quota for the Google Cloud project. */
  YT_DAILY_QUOTA: z.coerce.number().int().positive().default(10_000),
  /** Units held back for interactive searches; background refreshes stop above this. */
  YT_QUOTA_RESERVE: z.coerce.number().int().nonnegative().default(1_500),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server environment: ${issues}. See .env.example.`);
  }
  cached = parsed.data;
  return cached;
}

/** True when the Google OAuth variables are present (used to show setup help instead of crashing). */
export function isAuthConfigured(): boolean {
  return schema.safeParse(process.env).success;
}
