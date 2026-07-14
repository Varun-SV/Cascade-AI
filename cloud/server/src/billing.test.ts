import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifyWebhookSignature, planForStatus, subscriptionFromWebhook, billingConfig } from './billing.js';
import type { CloudEnv } from './env.js';

function sign(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyWebhookSignature', () => {
  it('accepts a correct signature and rejects tampering', () => {
    const body = JSON.stringify({ event: 'subscription.charged' });
    const secret = 'whsec_test';
    expect(verifyWebhookSignature(body, sign(body, secret), secret)).toBe(true);
    expect(verifyWebhookSignature(body + 'x', sign(body, secret), secret)).toBe(false);
    expect(verifyWebhookSignature(body, sign(body, 'other'), secret)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(body, sign(body, secret), '')).toBe(false);
  });
});

describe('planForStatus', () => {
  it('maps active/charged to pro, everything else to free', () => {
    expect(planForStatus('active')).toBe('pro');
    expect(planForStatus('authenticated')).toBe('pro');
    expect(planForStatus('charged')).toBe('pro');
    expect(planForStatus('cancelled')).toBe('free');
    expect(planForStatus('halted')).toBe('free');
    expect(planForStatus('completed')).toBe('free');
    expect(planForStatus(undefined)).toBe('free');
  });
});

describe('subscriptionFromWebhook', () => {
  it('extracts the subscription entity, or null for a malformed body', () => {
    const ok = subscriptionFromWebhook({
      event: 'subscription.charged',
      payload: { subscription: { entity: { id: 'sub_1', status: 'active', current_end: 123 } } },
    });
    expect(ok).toEqual({ subscriptionId: 'sub_1', status: 'active', currentEnd: 123 });
    expect(subscriptionFromWebhook({})).toBeNull();
    expect(subscriptionFromWebhook({ payload: { subscription: { entity: { status: 'active' } } } })).toBeNull();
  });
});

describe('billingConfig', () => {
  const base = { RAZORPAY_PRICE_LABEL: '₹499 / month' } as CloudEnv;
  it('returns null unless key id, secret, and plan id are all set', () => {
    expect(billingConfig({ ...base } as CloudEnv)).toBeNull();
    expect(billingConfig({ ...base, RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's' } as CloudEnv)).toBeNull();
    const cfg = billingConfig({
      ...base, RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's', RAZORPAY_PLAN_ID: 'plan_1', RAZORPAY_WEBHOOK_SECRET: 'w',
    } as CloudEnv);
    expect(cfg).toEqual({ keyId: 'k', keySecret: 's', webhookSecret: 'w', planId: 'plan_1', priceLabel: '₹499 / month' });
  });
});
