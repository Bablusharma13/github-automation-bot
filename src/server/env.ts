import "server-only";
import { z } from "zod";
import { isSlackWebhookUrl } from "@/lib/slack-url";

/**
 * Server-side environment. Parsed lazily (on first use) so that `next build` does not
 * require production secrets, and so a misconfiguration fails loudly on the first
 * request instead of producing half-working behaviour.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_URL: z
      .url()
      .transform((u) => u.replace(/\/+$/, ""))
      .refine((u) => new URL(u).origin === u, "must be an origin only (scheme://host[:port], no path)")
      .describe("Public origin of the app, e.g. https://example.vercel.app"),
    DATABASE_URL: z.string().min(1),
    GITHUB_CLIENT_ID: z.string().min(1),
    GITHUB_CLIENT_SECRET: z.string().min(1),
    GITHUB_WEBHOOK_SECRET: z.string().min(16, "use at least 16 random characters"),
    TOKEN_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded"),
    CRON_SECRET: z.string().min(16, "use at least 16 random characters"),
    // Optional deployment-wide default for users who have not saved their own webhook.
    SLACK_WEBHOOK_URL: z
      .string()
      .optional()
      .transform((v) => (v === "" ? undefined : v))
      .refine((v) => v === undefined || isSlackWebhookUrl(v), "must be a Slack Incoming Webhook URL"),
    // Optional override for the URL registered on GitHub repository webhooks. GitHub
    // refuses localhost URLs, so local development points this at a public HTTPS tunnel.
    // Defaults to `${APP_URL}/api/webhooks/github`.
    GITHUB_WEBHOOK_URL: z
      .string()
      .optional()
      .transform((v) => (v === "" ? undefined : v))
      .pipe(
        z
          .url()
          .refine((u) => u.startsWith("https://"), "must be an https:// URL")
          .optional(),
      ),
    // Optional: enables AI triage suggestions through the Gemini API (free tier). Without
    // it, rules that ask for AI triage record the step as skipped.
    GEMINI_API_KEY: z
      .string()
      .optional()
      .transform((v) => (v === "" ? undefined : v)),
    // Optional model override; the id is interpolated into the request path, so only
    // plain model ids are accepted.
    GEMINI_MODEL: z
      .string()
      .optional()
      .transform((v) => (v === "" ? undefined : v))
      .pipe(
        z
          .string()
          .regex(/^[a-z0-9][a-z0-9.-]{0,63}$/, "must be a Gemini model id, e.g. gemini-3.5-flash-lite")
          .optional(),
      ),
  })
  .superRefine((env, ctx) => {
    // Secure cookies are derived from the APP_URL scheme, so production must be HTTPS.
    // Plain-HTTP localhost stays allowed for `next start` smoke tests.
    const url = new URL(env.APP_URL);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (env.NODE_ENV === "production" && url.protocol !== "https:" && !isLocal) {
      ctx.addIssue({ code: "custom", path: ["APP_URL"], message: "must use https in production" });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Only report which variables are wrong, never their values.
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server environment: ${problems}`);
  }
  cached = parsed.data;
  return cached;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
