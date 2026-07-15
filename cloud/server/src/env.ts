// ─────────────────────────────────────────────
//  Cascade Cloud Server — Environment Config
// ─────────────────────────────────────────────

import { z } from 'zod';

// CLOUD_DEV_BYPASS lets local dev/tests log in without real OAuth apps
// configured; it must never be settable in a way that survives into a real
// deploy, so callers treat it as boolean-string ("1"/"true") and default off.
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),
  DATA_DIR: z.string().default('./data'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  OAUTH_REDIRECT_BASE_URL: z.string().default('http://localhost:8787'),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  CLOUD_DEV_BYPASS: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  // Hard per-run cost ceiling passed straight to Cascade's own budget guard
  // (src/core/router — maxCostPerRunUsd). A safety rail on the shared server
  // ahead of real per-plan entitlements (task #29).
  MAX_COST_PER_RUN_USD: z.coerce.number().positive().default(0.5),
  // Razorpay recurring subscriptions. All optional — billing is simply disabled
  // (the Upgrade page shows "not configured") until KEY_ID/KEY_SECRET/PLAN_ID
  // are set. WEBHOOK_SECRET verifies the /api/billing/webhook signature.
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAY_PLAN_ID: z.string().optional(),
  // Display-only price string for the Pro plan (actual price lives on the
  // Razorpay Plan). Shown on the Upgrade page.
  RAZORPAY_PRICE_LABEL: z.string().default('₹499 / month'),
});

export type CloudEnv = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): CloudEnv {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid cloud server environment:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  return parsed.data;
}
