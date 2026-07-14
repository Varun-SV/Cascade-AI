// ─────────────────────────────────────────────
//  Cascade Cloud Server — Razorpay billing
// ─────────────────────────────────────────────
//
// Recurring subscriptions. Everything is gated on RAZORPAY_KEY_ID/KEY_SECRET/
// PLAN_ID being set — with them absent, billing() returns null and the API
// reports "not configured" instead of erroring. Secrets live only in env; the
// client only ever receives the public key id + subscription id.

import Razorpay from 'razorpay';
import crypto from 'node:crypto';
import type { CloudEnv } from './env.js';

export interface BillingConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  planId: string;
  priceLabel: string;
}

/** Resolves billing config from env, or null when not fully configured. */
export function billingConfig(env: CloudEnv): BillingConfig | null {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !env.RAZORPAY_PLAN_ID) return null;
  return {
    keyId: env.RAZORPAY_KEY_ID,
    keySecret: env.RAZORPAY_KEY_SECRET,
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? '',
    planId: env.RAZORPAY_PLAN_ID,
    priceLabel: env.RAZORPAY_PRICE_LABEL,
  };
}

export function makeRazorpay(cfg: BillingConfig): Razorpay {
  return new Razorpay({ key_id: cfg.keyId, key_secret: cfg.keySecret });
}

export interface CreatedSubscription {
  id: string;
  status: string;
  currentEnd: number | null;
}

/** Creates a 12-cycle subscription against the configured plan. */
export async function createSubscription(rzp: Razorpay, planId: string): Promise<CreatedSubscription> {
  const sub = (await rzp.subscriptions.create({
    plan_id: planId,
    total_count: 12,
    customer_notify: 1,
  })) as unknown as { id: string; status: string; current_end?: number | null };
  return { id: sub.id, status: sub.status, currentEnd: sub.current_end ?? null };
}

/** Cancels a subscription at the end of the current billing cycle. */
export async function cancelSubscription(rzp: Razorpay, subscriptionId: string): Promise<void> {
  // cancel_at_cycle_end=1 → user keeps access until the paid period ends.
  await rzp.subscriptions.cancel(subscriptionId, true);
}

/**
 * Verifies a Razorpay webhook signature (HMAC-SHA256 of the RAW body with the
 * webhook secret). Timing-safe. Returns false on any mismatch/parse issue.
 */
export function verifyWebhookSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Maps a Razorpay subscription status to the user's plan. */
export function planForStatus(status: string | undefined): 'free' | 'pro' {
  return status && ['active', 'authenticated', 'charged'].includes(status) ? 'pro' : 'free';
}

export interface WebhookSubscription {
  subscriptionId: string;
  status: string;
  currentEnd: number | null;
}

/** Extracts the subscription entity from a verified webhook payload, or null. */
export function subscriptionFromWebhook(body: unknown): WebhookSubscription | null {
  const entity = (body as { payload?: { subscription?: { entity?: { id?: string; status?: string; current_end?: number | null } } } })
    ?.payload?.subscription?.entity;
  if (!entity?.id || !entity.status) return null;
  return { subscriptionId: entity.id, status: entity.status, currentEnd: entity.current_end ?? null };
}
