// ─────────────────────────────────────────────
//  Cascade AI — Who authorized this browser lease
// ─────────────────────────────────────────────
//
//  Two signed objects, because two parties each hold something the other must
//  not be able to produce (docs/design/stage-1-plan.md section 2):
//
//    Run grant        server → device   "this server asks this device to serve
//                                        this run for this user"
//    Device approval  device → server   "this user approved, on this device, for
//                                        this tab and these origins"
//
//  Authority is the intersection. The device enforces its OWN record of what the
//  user approved, never a list the server sends back, so a compromised server can
//  ask but can't widen. A compromised device can sign only for itself: the server
//  refuses an approval whose grant doesn't match what it issued.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { POLICY_VERSION } from './command-policy.js';

const GRANT_DOMAIN = 'cascade.relay.grant.v1';
const HELLO_DOMAIN = 'cascade.relay.hello.v1';
const APPROVAL_DOMAIN = 'cascade.relay.approval.v1';
/** The longest any grant or approval may live. */
export const MAX_LIFETIME_MS = 30 * 60_000;
const CLOCK_SKEW_MS = 30_000;

export interface GrantPayload {
  iss: string; aud: string; userId: string; deviceId: string; runId: string;
  iat: number; exp: number; nonce: string; policyVersion: number;
}
export interface ApprovalPayload {
  grantHash: string; iss: string; aud: string; tabTargetId: string;
  allowedOrigins: string[]; privateOrigins: string[];
  iat: number; exp: number; nonce: string; policyVersion: number;
}
export interface Signed<T> { payload: T; sig: string }

const GRANT_FIELDS = ['aud', 'deviceId', 'exp', 'iat', 'iss', 'nonce', 'policyVersion', 'runId', 'userId'];
const APPROVAL_FIELDS = ['allowedOrigins', 'aud', 'exp', 'grantHash', 'iat', 'iss', 'nonce', 'policyVersion', 'privateOrigins', 'tabTargetId'];

/** RFC 8785 for the values these payloads hold: strings, safe integers, arrays and objects. */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('only safe integers can be signed');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new Error(`cannot sign a ${typeof value}`);
}

const toSign = (domain: string, payload: object): Buffer => Buffer.from(`${domain}\n${canonicalJson(payload)}`);

/** A party's signing key. Enrollment and storage are stage 2; stage 1 injects these. */
export interface Identity { id: string; sign(bytes: Buffer): string; publicKey: KeyObject }

export function createIdentity(id: string): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { id, publicKey, sign: (bytes) => edSign(null, bytes, privateKey).toString('base64url') };
}

/** A new key pair, as text that can be stored: the private key as PKCS#8 PEM, the public as SPKI base64url. */
export function generateStoredKey(): { privateKeyPem: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicKey: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64url'),
  };
}

/** An identity from a stored private key. Throws on anything but an Ed25519 key. */
export function identityFromPrivateKey(id: string, privateKeyPem: string): Identity {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('relay keys are Ed25519');
  return { id, publicKey: createPublicKey(privateKey), sign: (bytes) => edSign(null, bytes, privateKey).toString('base64url') };
}

/** A public key as registered: SPKI, base64url. Null on anything but an Ed25519 key. */
export function publicKeyFromText(text: string): KeyObject | null {
  try {
    const key = createPublicKey({ key: Buffer.from(text, 'base64url'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch { return null; }
}

export function publicKeyToText(key: KeyObject): string {
  return (key.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64url');
}

/**
 * The device proves it holds its registered key, to this server, for this one
 * connection: a signature over the server's fresh challenge. Nothing here can be
 * replayed on another connection or to another server.
 */
export function signHello(device: Identity, serverId: string, challenge: string): string {
  return device.sign(toSign(HELLO_DOMAIN, { challenge, deviceId: device.id, serverId }));
}

export function verifyHello(sig: unknown, deviceKey: KeyObject, fields: { deviceId: string; serverId: string; challenge: string }): boolean {
  if (typeof sig !== 'string') return false;
  try {
    return edVerify(null, toSign(HELLO_DOMAIN, { challenge: fields.challenge, deviceId: fields.deviceId, serverId: fields.serverId }), deviceKey, Buffer.from(sig, 'base64url'));
  } catch { return false; }
}

function verifySig(domain: string, signed: Signed<object>, key: KeyObject): boolean {
  if (typeof signed.sig !== 'string') return false;
  try { return edVerify(null, toSign(domain, signed.payload), key, Buffer.from(signed.sig, 'base64url')); } catch { return false; }
}

export function grantHash(grant: Signed<GrantPayload>): string {
  return createHash('sha256').update(toSign(GRANT_DOMAIN, grant.payload)).digest('base64url');
}

const hasExactly = (o: object, fields: readonly string[]): boolean => {
  const keys = Object.keys(o).sort();
  return keys.length === fields.length && keys.every((k, i) => k === fields[i]);
};

export type Check = { ok: true } | { ok: false; reason: string };
const no = (reason: string): Check => ({ ok: false, reason });
const YES: Check = { ok: true };

function checkTimes(p: { iat: number; exp: number; policyVersion: number }, now: number): Check {
  if (p.policyVersion !== POLICY_VERSION) return no('policy version mismatch');
  if (!Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp)) return no('malformed times');
  if (p.exp - p.iat > MAX_LIFETIME_MS) return no('lifetime too long');
  if (p.iat > now + CLOCK_SKEW_MS) return no('issued in the future');
  if (now >= p.exp) return no('expired');
  return YES;
}

/** Issued by the server. */
export function issueGrant(
  server: Identity,
  fields: { userId: string; deviceId: string; runId: string; ttlMs: number; now: number },
): Signed<GrantPayload> {
  const payload: GrantPayload = {
    iss: server.id, aud: fields.deviceId, userId: fields.userId, deviceId: fields.deviceId, runId: fields.runId,
    iat: fields.now, exp: fields.now + Math.min(fields.ttlMs, MAX_LIFETIME_MS),
    nonce: randomBytes(18).toString('base64url'), policyVersion: POLICY_VERSION,
  };
  return { payload, sig: server.sign(toSign(GRANT_DOMAIN, payload)) };
}

/** Checked by the device, before asking the user, and again by the server. */
export function verifyGrant(grant: Signed<GrantPayload>, serverKey: KeyObject, expect: { serverId: string; deviceId: string }, now: number): Check {
  if (!grant?.payload || !hasExactly(grant.payload, GRANT_FIELDS)) return no('malformed grant');
  if (!verifySig(GRANT_DOMAIN, grant, serverKey)) return no('bad grant signature');
  const p = grant.payload;
  if (p.iss !== expect.serverId) return no('grant from another server');
  if (p.aud !== expect.deviceId || p.deviceId !== expect.deviceId) return no('grant for another device');
  return checkTimes(p, now);
}

export interface ApprovedScope { tabTargetId: string; allowedOrigins: string[]; privateOrigins: string[] }

function verifyApprovalSignature(approval: Signed<ApprovalPayload>, deviceKey: KeyObject): Check {
  if (!approval?.payload || !hasExactly(approval.payload, APPROVAL_FIELDS)) return no('malformed approval');
  if (!verifySig(APPROVAL_DOMAIN, approval, deviceKey)) return no('bad approval signature');
  return YES;
}

// ── Single use ───────────────────────────────────────────────────────────────

/** The store could not record a claim, and definitely did not insert it. */
export class StoreUnavailable extends Error {}
/** The store's answer was lost: the claim may or may not have been recorded. */
export class StoreOutcomeUnknown extends Error {}

/**
 * Must be atomic across every server instance: of any number of concurrent
 * calls for one key, exactly one returns true. Stage 2 supplies the real one.
 */
export interface NonceStore {
  claimOnce(key: string, exp: number): Promise<boolean>;
}

/** One process only, so it can't be the production store on a multi-instance server. */
export function createMemoryNonceStore(now: () => number): NonceStore {
  const used = new Map<string, number>();
  return {
    async claimOnce(key, exp) {
      const t = now();
      for (const [k, e] of used) if (e + CLOCK_SKEW_MS < t) used.delete(k);
      if (used.has(key)) return false;
      used.set(key, exp);
      return true;
    },
  };
}

// ── The server's side ────────────────────────────────────────────────────────

export interface IssuedRun { userId: string; deviceId: string; runId: string }

export type ClaimResult =
  | { outcome: 'claimed' }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'replay' }
  | { outcome: 'unavailable' }
  | { outcome: 'unknown' };

/**
 * The server's check of a grant and approval, then the one-time claim. `issued`
 * is the server's own record of what it issued, looked up by grant nonce: a run
 * is routed by the grant it was given, never by user alone.
 */
export async function claimAtServer(opts: {
  server: Identity;
  store: NonceStore;
  grant: Signed<GrantPayload>;
  approval: Signed<ApprovalPayload>;
  /** The key registered for this device, or null if there's none. */
  deviceKey: (deviceId: string) => KeyObject | null;
  issued: (grantNonce: string) => IssuedRun | null;
  now: number;
}): Promise<ClaimResult> {
  const refused = (reason: string): ClaimResult => ({ outcome: 'refused', reason });
  const { grant, approval, server, now } = opts;
  const deviceId = grant?.payload?.deviceId;
  if (typeof deviceId !== 'string') return refused('malformed grant');
  const g = verifyGrant(grant, server.publicKey, { serverId: server.id, deviceId }, now);
  if (!g.ok) return refused(g.reason);
  const run = opts.issued(grant.payload.nonce);
  if (!run) return refused('grant was not issued here');
  if (run.userId !== grant.payload.userId || run.deviceId !== deviceId || run.runId !== grant.payload.runId) return refused('grant does not match the issued run');
  const key = opts.deviceKey(deviceId);
  if (!key) return refused('device is not registered');
  const a = verifyApprovalSignature(approval, key);
  if (!a.ok) return refused(a.reason);
  const p = approval.payload;
  if (p.grantHash !== grantHash(grant)) return refused('approval is for another grant');
  if (p.iss !== deviceId) return refused('approval from another device');
  if (p.aud !== server.id) return refused('approval for another server');
  if (p.exp > grant.payload.exp) return refused('approval outlives its grant');
  const t = checkTimes(p, now);
  if (!t.ok) return refused(t.reason);
  try {
    // Keyed by the grant: each grant yields one lease, however many approvals exist.
    return (await opts.store.claimOnce(grant.payload.nonce, grant.payload.exp)) ? { outcome: 'claimed' } : { outcome: 'replay' };
  } catch (e) {
    return e instanceof StoreUnavailable ? { outcome: 'unavailable' } : { outcome: 'unknown' };
  }
}

// ── The device's side ────────────────────────────────────────────────────────

export interface DeviceApprovals {
  /** Call only after the user has approved. Verifies the grant first. */
  approve(grant: Signed<GrantPayload>, scope: ApprovedScope, ttlMs: number): Signed<ApprovalPayload> | { refused: string };
  /** The device's own record of an approval, if it may still be used. */
  admit(approval: Signed<ApprovalPayload>): { ok: true; scope: ApprovedScope; exp: number } | { ok: false; reason: string };
  /** Marks an approval used for good. */
  burn(nonce: string): void;
}

function frozenScope(scope: ApprovedScope): ApprovedScope {
  return Object.freeze({
    tabTargetId: scope.tabTargetId,
    allowedOrigins: Object.freeze([...scope.allowedOrigins]) as string[],
    privateOrigins: Object.freeze([...scope.privateOrigins]) as string[],
  });
}

export function createDeviceApprovals(opts: {
  device: Identity; serverId: string; serverKey: KeyObject; now: () => number;
}): DeviceApprovals {
  const { device, serverId, serverKey, now } = opts;
  const records = new Map<string, { scope: ApprovedScope; exp: number; used: boolean }>();
  return {
    approve(grant, scope, ttlMs) {
      const t = now();
      const g = verifyGrant(grant, serverKey, { serverId, deviceId: device.id }, t);
      if (!g.ok) return { refused: g.reason };
      const payload: ApprovalPayload = {
        grantHash: grantHash(grant), iss: device.id, aud: serverId, tabTargetId: scope.tabTargetId,
        allowedOrigins: [...scope.allowedOrigins], privateOrigins: [...scope.privateOrigins],
        iat: t, exp: Math.min(t + ttlMs, grant.payload.exp),
        nonce: randomBytes(18).toString('base64url'), policyVersion: POLICY_VERSION,
      };
      // The device's own copy, which nothing the caller holds can change.
      records.set(payload.nonce, { scope: frozenScope(scope), exp: payload.exp, used: false });
      return { payload, sig: device.sign(toSign(APPROVAL_DOMAIN, payload)) };
    },
    admit(approval) {
      const r = records.get(approval?.payload?.nonce);
      if (!r) return { ok: false, reason: 'not an approval this device gave' };
      if (r.used) return { ok: false, reason: 'approval already used' };
      if (now() >= r.exp) return { ok: false, reason: 'approval expired' };
      return { ok: true, scope: frozenScope(r.scope), exp: r.exp };
    },
    burn(nonce) {
      const r = records.get(nonce);
      if (r) r.used = true;
    },
  };
}

/** Verifies an approval's own signature, for a party holding the device's public key. */
export function approvalIsSigned(approval: Signed<ApprovalPayload>, deviceKey: KeyObject): boolean {
  return verifyApprovalSignature(approval, deviceKey).ok;
}
