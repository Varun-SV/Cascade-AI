// ─────────────────────────────────────────────
//  Desktop → Cascade Cloud — Conversation Handoff Client
// ─────────────────────────────────────────────
//
// "Open-and-continue" between the desktop app and the web app. The desktop
// backend is local and keyless w.r.t. the cloud, so it talks to the cloud's
// short-lived handoff courier (see cloud/server/src/handoff.ts) over plain,
// unauthenticated HTTPS: POST a transcript → get a code; GET a code → the
// transcript. The code is the only bearer secret; nothing is stored durably.

export interface HandoffMessage {
  role: string;
  content: string;
}

export interface HandoffSnapshot {
  title: string | null;
  skillId: string | null;
  messages: HandoffMessage[];
  expiresAt: number;
}

// The hosted cloud origin. Overridable for dev / self-host via a localStorage
// key or a global, so a local cloud server can be targeted without a rebuild.
export function cloudBaseUrl(): string {
  try {
    const override = localStorage.getItem('cascade-cloud-url');
    if (override && /^https?:\/\//.test(override)) return override.replace(/\/+$/, '');
  } catch {
    /* localStorage unavailable */
  }
  const g = (globalThis as { __CASCADE_CLOUD_URL__?: string }).__CASCADE_CLOUD_URL__;
  if (g && /^https?:\/\//.test(g)) return g.replace(/\/+$/, '');
  return 'https://cascadeai.in';
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

/** Snapshot a transcript into a short-lived code to pick up on the web. */
export async function createCloudHandoff(input: {
  title: string | null;
  skillId: string | null;
  messages: HandoffMessage[];
}): Promise<{ code: string; expiresAt: number }> {
  const res = await fetch(`${cloudBaseUrl()}/api/handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Request failed: ${res.status}`));
  return res.json() as Promise<{ code: string; expiresAt: number }>;
}

/** Redeem a code minted on the web → its transcript snapshot. */
export async function fetchCloudHandoff(code: string): Promise<HandoffSnapshot> {
  const res = await fetch(`${cloudBaseUrl()}/api/handoff/${encodeURIComponent(code)}`);
  if (!res.ok) throw new Error(await errorMessage(res, 'That code is invalid or has expired.'));
  return res.json() as Promise<HandoffSnapshot>;
}
