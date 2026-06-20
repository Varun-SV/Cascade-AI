// ─────────────────────────────────────────────────────────────────────────────
//  Cascade AI — standalone app design mockups → PNG
// ─────────────────────────────────────────────────────────────────────────────
//  Throwaway design artifacts (NOT shipped/bundled). Renders each proposed screen
//  to app/mockups/out/*.png using the real design tokens from app/index.html so
//  the mockups double as the implementation reference. Run:
//      node app/mockups/render.mjs
//  Uses the Chromium already present in this environment (no network download).

import pw from '/home/user/Cascade-AI/node_modules/playwright/index.js';
const { chromium } = pw;
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
fs.mkdirSync(OUT, { recursive: true });

const W = 1440, H = 900;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// ─── Design tokens (mirrors app/index.html :root) ────────────────────────────
const TOKENS = `
:root{
  --bg-base:#0a0a0d; --bg-surface:#111116; --bg-raised:#18181f; --bg-overlay:#1f1f28;
  --bg-hover:#26262f; --bg-active:#2e2e3a; --border:#26262f; --border-strong:#383844;
  --text:#ececf2; --text-muted:#8888a0; --text-dim:#5a5a6e;
  --accent:#8b7cf9; --accent-hover:#9d90fa; --accent-dim:#2a2358; --accent-soft:rgba(139,124,249,.14);
  --accent-2:#3ec9d6; --accent-2-soft:rgba(62,201,214,.14);
  --t1:#f5a623; --t1-soft:rgba(245,166,35,.14);
  --t2:#8b7cf9; --t2-soft:rgba(139,124,249,.14);
  --t3:#3ec9d6; --t3-soft:rgba(62,201,214,.14);
  --success:#3ecf8e; --success-soft:rgba(62,207,142,.14);
  --warn:#f5a623; --warn-soft:rgba(245,166,35,.14);
  --danger:#f0506e; --danger-soft:rgba(240,80,110,.14);
  --info:#3ec9d6;
  --radius-sm:5px; --radius-md:8px; --radius-lg:12px; --radius-xl:16px;
  --shadow-1:0 1px 2px rgba(0,0,0,.30),0 1px 3px rgba(0,0,0,.18);
  --shadow-2:0 8px 28px rgba(0,0,0,.38);
  --glow-accent:0 0 0 1px var(--accent-soft),0 4px 20px rgba(139,124,249,.22);
  --font-ui:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',system-ui,sans-serif;
  --font-mono:'JetBrains Mono','Fira Code',ui-monospace,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{
  background:
    radial-gradient(1200px 600px at 80% -10%, rgba(139,124,249,.06), transparent 60%),
    radial-gradient(900px 500px at -10% 110%, rgba(62,201,214,.05), transparent 55%),
    var(--bg-base);
  color:var(--text); font-family:var(--font-ui); font-size:13px; line-height:1.5;
  -webkit-font-smoothing:antialiased;
}
.app{display:flex;flex-direction:column;height:${H}px}
.row{display:flex;flex:1;overflow:hidden}
.col{flex:1;display:flex;flex-direction:column;overflow:hidden}
`;

// ─── Inline icons (lucide-ish) ───────────────────────────────────────────────
const I = {
  network: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4M12 12H5v4M12 12h7v4"/></svg>`,
  chat: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  code: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  settings: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  send: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
  bot: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 16h0M16 16h0"/></svg>`,
  user: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  terminal: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
  wifi: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 20 0"/><line x1="12" y1="20" x2="12" y2="20"/></svg>`,
  wifioff: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M8.5 16.5a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 4.17-2.65M10.66 5c4.01-.36 8.14.9 11.34 3.76M16.85 11.25a10 10 0 0 1 2.22 1.68"/></svg>`,
  coins: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18M7 6h1v4M16.71 13.88l.7.71-2.82 2.82"/></svg>`,
  folder: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  file: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  check: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  alert: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17"/></svg>`,
  folderopen: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6A2 2 0 0 1 18.45 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>`,
  sparkles: `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/></svg>`,
};

// ─── Shell pieces ────────────────────────────────────────────────────────────
function titleBar(connected = true) {
  return `<div style="height:40px;flex-shrink:0;display:flex;align-items:center;gap:9px;padding-left:12px;padding-right:138px;background:var(--bg-surface);border-bottom:1px solid var(--border)">
    <div style="width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,var(--accent),var(--accent-2));display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#fff;letter-spacing:-.5px">C</div>
    <span style="font-size:12.5px;font-weight:700;letter-spacing:-.2px">Cascade AI</span>
    <span style="width:6px;height:6px;border-radius:50%;background:${connected ? 'var(--success)' : 'var(--text-dim)'};box-shadow:${connected ? '0 0 6px var(--success)' : 'none'};margin-left:2px"></span>
    <div style="flex:1"></div>
    <div style="display:flex;gap:18px;align-items:center;color:var(--text-dim)">
      <span style="width:11px;height:1.5px;background:currentColor"></span>
      <span style="width:10px;height:10px;border:1.5px solid currentColor;border-radius:2px"></span>
      <span style="font-size:15px;line-height:1">✕</span>
    </div>
  </div>`;
}

function activityBar(active) {
  const item = (key, icon, on) => `<div style="position:relative;width:40px;height:40px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:${on ? 'var(--accent-soft)' : 'transparent'};color:${on ? 'var(--accent)' : 'var(--text-muted)'}">
    ${on ? '<span style="position:absolute;left:-10px;top:50%;transform:translateY(-50%);width:3px;height:18px;border-radius:2px;background:var(--accent)"></span>' : ''}${icon}</div>`;
  return `<div style="width:52px;background:var(--bg-surface);border-right:1px solid var(--border);display:flex;flex-direction:column;align-items:center;padding-top:10px;gap:6px;flex-shrink:0">
    ${item('cockpit', I.network, active === 'cockpit')}
    ${item('chat', I.chat, active === 'chat')}
    ${item('code', I.code, active === 'code')}
    <div style="flex:1"></div>
    ${item('settings', I.settings, active === 'settings')}
    <div style="height:8px"></div>
  </div>`;
}

function statusBar({ connected = true, cost = '<$0.001', tokens = '0', t1 = 'auto', t2 = 'auto', t3 = 'auto' } = {}) {
  const chip = (t, c, m) => `<span style="display:flex;align-items:center;gap:5px"><span style="font-size:9px;font-weight:800;letter-spacing:.5px;color:${c};padding:1px 4px;border-radius:3px;background:color-mix(in srgb,${c} 14%,transparent)">${t}</span><span style="font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted)">${m}</span></span>`;
  const div = `<span style="width:1px;height:12px;background:var(--border-strong);opacity:.6"></span>`;
  return `<div style="height:24px;background:var(--bg-surface);display:flex;align-items:center;padding:0 10px;gap:14px;font-size:11px;color:var(--text-muted);border-top:1px solid var(--border);flex-shrink:0">
    <span style="display:flex;align-items:center;gap:5px;color:${connected ? 'var(--success)' : 'var(--text-dim)'};font-weight:600">
      <span style="width:7px;height:7px;border-radius:50%;background:${connected ? 'var(--success)' : 'var(--text-dim)'};box-shadow:${connected ? '0 0 6px var(--success)' : 'none'}"></span>
      ${connected ? I.wifi : I.wifioff}${connected ? 'connected' : 'offline'}</span>
    ${div}${chip('T1', 'var(--t1)', t1)}${chip('T2', 'var(--t2)', t2)}${chip('T3', 'var(--t3)', t3)}
    <div style="flex:1"></div>
    <span style="display:flex;align-items:center;gap:5px">${I.coins}${tokens} tok</span>
    <span style="font-weight:600;color:var(--text)">${cost}</span>
    ${div}<span style="display:flex;align-items:center;gap:5px">${I.terminal} terminal</span>
  </div>`;
}

const page = (body, { connected = true } = {}) =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${TOKENS}</style></head><body><div class="app">${titleBar(connected)}${body}</div></body></html>`;

// ─── Screen 1: Onboarding ────────────────────────────────────────────────────
function onboarding() {
  const prov = (name, initial, color, selected) => `<div style="flex:1;border:1.5px solid ${selected ? 'var(--accent)' : 'var(--border)'};background:${selected ? 'var(--accent-soft)' : 'var(--bg-raised)'};border-radius:var(--radius-lg);padding:16px;display:flex;flex-direction:column;align-items:center;gap:9px;position:relative">
    ${selected ? `<span style="position:absolute;top:9px;right:9px;width:18px;height:18px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center">${I.check}</span>` : ''}
    <div style="width:40px;height:40px;border-radius:10px;background:${color};display:flex;align-items:center;justify-content:center;font-weight:800;font-size:18px;color:#fff">${initial}</div>
    <span style="font-size:12.5px;font-weight:600">${name}</span></div>`;
  const body = `<div style="flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden">
    <div style="width:560px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-xl);box-shadow:var(--shadow-2);padding:36px 40px">
      <div style="display:flex;flex-direction:column;align-items:center;text-align:center;margin-bottom:26px">
        <div style="width:60px;height:60px;border-radius:16px;background:linear-gradient(135deg,var(--accent),var(--accent-2));display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:var(--glow-accent);margin-bottom:16px;font-size:28px;font-weight:800;letter-spacing:-1px">C</div>
        <div style="font-size:22px;font-weight:800;letter-spacing:-.4px">Welcome to Cascade AI</div>
        <div style="font-size:13.5px;color:var(--text-muted);margin-top:6px">Connect a provider to start orchestrating. Everything runs locally — no separate CLI needed.</div>
      </div>
      <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--text-dim);margin-bottom:10px">1 · Choose a provider</div>
      <div style="display:flex;gap:10px;margin-bottom:22px">
        ${prov('Anthropic', 'A', 'linear-gradient(135deg,#c96442,#e08a6a)', true)}
        ${prov('OpenAI', 'O', 'linear-gradient(135deg,#10a37f,#1abc9c)', false)}
        ${prov('Google', 'G', 'linear-gradient(135deg,#4285f4,#3ec9d6)', false)}
      </div>
      <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--text-dim);margin-bottom:10px">2 · API key</div>
      <div style="display:flex;align-items:center;background:var(--bg-raised);border:1px solid var(--accent);border-radius:var(--radius-md);padding:11px 13px;margin-bottom:8px;box-shadow:var(--glow-accent)">
        <span style="font-family:var(--font-mono);font-size:13px;color:var(--text);letter-spacing:1px">sk-ant-••••••••••••••••••••••••••••</span>
        <div style="flex:1"></div><span style="font-size:11px;color:var(--success);display:flex;align-items:center;gap:4px">${I.check} valid</span></div>
      <div style="font-size:11.5px;color:var(--text-dim);margin-bottom:22px">Stored securely in your OS keychain. Never leaves this device.</div>
      <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--text-dim);margin-bottom:10px">3 · Default workspace</div>
      <div style="display:flex;align-items:center;gap:9px;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-md);padding:11px 13px;margin-bottom:26px;color:var(--text-muted)">
        ${I.folderopen}<span style="font-family:var(--font-mono);font-size:12.5px;color:var(--text)">~/projects/cascade-ai</span><div style="flex:1"></div><span style="font-size:11.5px;color:var(--accent);font-weight:600">Browse…</span></div>
      <button style="width:100%;border:none;border-radius:var(--radius-md);padding:13px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;font-size:14px;font-weight:700;box-shadow:var(--shadow-1)">Get started →</button>
    </div></div>`;
  return page(body, { connected: false });
}

// ─── Screen 2: Cockpit — empty ───────────────────────────────────────────────
function cockpitEmpty() {
  const body = `<div class="row">${activityBar('cockpit')}<div class="col">
    <div style="padding:11px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
      <span style="color:var(--accent)">${I.network}</span><span style="font-weight:700;font-size:13px">Cockpit</span>
      <div style="flex:1"></div><span style="font-size:11px;color:var(--text-dim)">Multi-tier orchestration</span></div>
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px">
      <div style="width:72px;height:72px;border-radius:20px;background:var(--bg-raised);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;color:var(--accent);margin-bottom:20px;box-shadow:var(--shadow-1)">${I.sparkles}</div>
      <div style="font-size:18px;font-weight:700;letter-spacing:-.2px">Ready to orchestrate</div>
      <div style="font-size:13.5px;color:var(--text-muted);margin-top:7px;max-width:420px;text-align:center">Describe a goal and Cascade decomposes it across T1 · T2 · T3 agents, routing each step to the best model.</div>
      <div style="display:flex;gap:8px;margin-top:20px">
        ${['Refactor the auth module', 'Add tests for the router', 'Audit deps for CVEs'].map(s => `<span style="font-size:12px;color:var(--text-muted);background:var(--bg-raised);border:1px solid var(--border);border-radius:999px;padding:7px 13px">${s}</span>`).join('')}
      </div></div>
    <div style="padding:14px 18px;border-top:1px solid var(--border);background:var(--bg-surface)">
      <div style="display:flex;align-items:flex-end;gap:10px">
        <div style="flex:1;background:var(--bg-raised);border:1px solid var(--accent);border-radius:var(--radius-md);padding:12px 14px;color:var(--text-dim);font-size:13px;box-shadow:var(--glow-accent);min-height:48px">Describe a goal for Cascade to orchestrate…</div>
        <button style="width:44px;height:44px;border:none;border-radius:var(--radius-md);background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:var(--shadow-1)">${I.send}</button>
      </div></div>
  </div></div>${statusBar()}`;
  return page(body);
}

// ─── Screen 3: Cockpit — active orchestration ────────────────────────────────
function node(tier, color, label, sub, status, pct) {
  const statusColor = { ACTIVE: 'var(--accent)', DONE: 'var(--success)', IDLE: 'var(--text-dim)' }[status] || 'var(--text-dim)';
  return `<div style="width:200px;background:var(--bg-raised);border:1px solid ${status === 'ACTIVE' ? color : 'var(--border)'};border-radius:var(--radius-lg);padding:13px;box-shadow:${status === 'ACTIVE' ? '0 0 0 1px ' + color + ',0 6px 22px rgba(0,0,0,.35)' : 'var(--shadow-1)'}">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px">
      <span style="font-size:9px;font-weight:800;letter-spacing:.5px;color:${color};padding:2px 6px;border-radius:4px;background:color-mix(in srgb,${color} 16%,transparent)">${tier}</span>
      <span style="font-size:12.5px;font-weight:700">${label}</span>
      <div style="flex:1"></div>
      <span style="width:7px;height:7px;border-radius:50%;background:${statusColor};box-shadow:${status === 'ACTIVE' ? '0 0 7px ' + statusColor : 'none'}"></span></div>
    <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:10px;height:16px;overflow:hidden">${sub}</div>
    <div style="height:5px;border-radius:3px;background:var(--bg-active);overflow:hidden"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,${color},color-mix(in srgb,${color} 60%,#fff))"></div></div></div>`;
}
function connector(h = 26) { return `<div style="width:2px;height:${h}px;background:linear-gradient(var(--border-strong),var(--border))"></div>`; }

function cockpitActive() {
  const body = `<div class="row">${activityBar('cockpit')}<div class="col">
    <div style="padding:11px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
      <span style="color:var(--accent)">${I.network}</span><span style="font-weight:700;font-size:13px">Cockpit</span>
      <span style="font-size:11px;color:var(--text-muted);background:var(--accent-soft);border:1px solid var(--accent-dim);border-radius:999px;padding:3px 10px;margin-left:4px">Running · refactor auth module</span>
      <div style="flex:1"></div>
      <div style="display:flex;gap:14px;font-size:11px;color:var(--text-muted)">
        <span>3 tiers</span><span>·</span><span>5 agents</span><span>·</span><span style="color:var(--success)">2 done</span></div></div>
    <div style="flex:1;overflow:hidden;display:flex;flex-direction:column;align-items:center;padding:26px 24px;gap:0">
      ${node('T1', 'var(--t1)', 'Administrator', 'Decomposing into 3 sections', 'ACTIVE', 64)}
      ${connector()}
      <div style="display:flex;gap:60px">
        <div style="display:flex;flex-direction:column;align-items:center">${node('T2', 'var(--t2)', 'Coordinator A', 'Auth refactor · 2 subtasks', 'ACTIVE', 48)}</div>
        <div style="display:flex;flex-direction:column;align-items:center">${node('T2', 'var(--t2)', 'Coordinator B', 'Test coverage', 'DONE', 100)}</div>
      </div>
      ${connector(22)}
      <div style="display:flex;gap:18px">
        ${node('T3', 'var(--t3)', 'Worker · edit', 'Patching session.ts', 'ACTIVE', 72)}
        ${node('T3', 'var(--t3)', 'Worker · grep', 'Scanning callers', 'DONE', 100)}
        ${node('T3', 'var(--t3)', 'Worker · test', 'Queued', 'IDLE', 8)}
      </div></div>
    <div style="padding:14px 18px;border-top:1px solid var(--border);background:var(--bg-surface)">
      <div style="display:flex;align-items:flex-end;gap:10px">
        <div style="flex:1;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-md);padding:12px 14px;color:var(--text-dim);font-size:13px;min-height:48px">Add a follow-up instruction…</div>
        <button style="width:44px;height:44px;border:none;border-radius:var(--radius-md);background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:var(--shadow-1)">${I.send}</button>
      </div></div>
  </div></div>${statusBar({ cost: '$0.0428', tokens: '18.4k', t1: 'opus-4.8', t2: 'sonnet-4.6', t3: 'haiku-4.5' })}`;
  return page(body);
}

// ─── Screen 4: Chat ──────────────────────────────────────────────────────────
function chat() {
  const bubble = (role, text, streaming) => {
    const u = role === 'user';
    return `<div style="display:flex;gap:10px;align-items:flex-start;flex-direction:${u ? 'row-reverse' : 'row'}">
      <div style="width:30px;height:30px;border-radius:50%;flex-shrink:0;background:${u ? 'linear-gradient(135deg,var(--accent),var(--accent-2))' : 'var(--bg-raised)'};border:${u ? 'none' : '1px solid var(--border)'};color:${u ? '#fff' : 'var(--accent)'};display:flex;align-items:center;justify-content:center">${u ? I.user : `<span style="transform:scale(.62)">${I.bot}</span>`}</div>
      <div style="max-width:74%;background:${u ? 'var(--accent-soft)' : 'var(--bg-raised)'};border:1px solid ${u ? 'var(--accent-dim)' : 'var(--border)'};border-radius:${u ? '12px 12px 4px 12px' : '12px 12px 12px 4px'};padding:10px 14px;font-size:13px;line-height:1.65;color:var(--text)">${text}${streaming ? '<span style="display:inline-block;width:7px;height:14px;margin-left:2px;background:var(--accent);border-radius:1px;vertical-align:middle"></span>' : ''}</div></div>`;
  };
  const body = `<div class="row">${activityBar('chat')}<div class="col">
    <div style="padding:11px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
      <span style="color:var(--accent)">${I.chat}</span><span style="font-weight:700;font-size:13px">Chat</span>
      <span style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--text-muted);background:var(--bg-raised);border:1px solid var(--border);border-radius:999px;padding:4px 10px;margin-left:4px"><span style="width:6px;height:6px;border-radius:50%;background:var(--accent)"></span>Claude Sonnet 4.6 ▾</span>
      <div style="flex:1"></div></div>
    <div style="flex:1;overflow:hidden;padding:18px;display:flex;flex-direction:column;gap:16px">
      ${bubble('user', 'Summarize the routing logic in <span style="font-family:var(--font-mono);font-size:12px">live-data.ts</span> and where scores come from.')}
      ${bubble('assistant', 'Cascade Auto blends three sources with graceful fallback:<br><br><b>1.</b> Live quality scores from a GitHub-raw snapshot, cached to disk (24h TTL).<br><b>2.</b> Per-token pricing from OpenRouter (free, no key).<br><b>3.</b> A bundled offline baseline when both are unreachable.<br><br>Each model family is scored 0–100 across <span style="color:var(--t1)">code</span>, <span style="color:var(--t2)">analysis</span>, <span style="color:var(--t3)">creative</span>, and data', true)}
    </div>
    <div style="padding:12px;border-top:1px solid var(--border);background:var(--bg-surface);display:flex;gap:10px;align-items:flex-end">
      <div style="flex:1;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-md);padding:11px 13px;color:var(--text-dim);font-size:13px;min-height:46px">Message Cascade…  (Enter to send)</div>
      <button style="width:42px;height:42px;border:none;border-radius:var(--radius-md);background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:var(--shadow-1)">${I.send}</button>
    </div>
  </div></div>${statusBar({ cost: '$0.0061', tokens: '2.1k', t1: 'sonnet-4.6' })}`;
  return page(body);
}

// ─── Screen 5: Code ──────────────────────────────────────────────────────────
function code() {
  const tree = (name, depth, kind, active) => `<div style="display:flex;align-items:center;gap:7px;padding:4px 8px;padding-left:${8 + depth * 14}px;border-radius:5px;background:${active ? 'var(--accent-soft)' : 'transparent'};color:${active ? 'var(--text)' : 'var(--text-muted)'};font-size:12.5px">${kind === 'dir' ? `<span style="color:var(--accent-2)">${I.folder}</span>` : `<span style="color:var(--text-dim)">${I.file}</span>`}${name}</div>`;
  const ln = (n, html) => `<div style="display:flex"><span style="width:38px;text-align:right;padding-right:14px;color:var(--text-dim);user-select:none">${n}</span><span>${html}</span></div>`;
  const kw = (t) => `<span style="color:#c678dd">${t}</span>`;
  const fn = (t) => `<span style="color:#61afef">${t}</span>`;
  const str = (t) => `<span style="color:#98c379">${t}</span>`;
  const com = (t) => `<span style="color:var(--text-dim)">${t}</span>`;
  const body = `<div class="row">${activityBar('code')}<div class="col">
    <div style="flex:1;display:flex;overflow:hidden">
      <div style="width:230px;background:var(--bg-surface);border-right:1px solid var(--border);display:flex;flex-direction:column">
        <div style="padding:10px 12px;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text-dim);display:flex;align-items:center;gap:7px">${I.folderopen} cascade-ai</div>
        <div style="padding:2px 6px;overflow:hidden">
          ${tree('src', 0, 'dir')}${tree('core', 1, 'dir')}${tree('router', 2, 'dir')}
          ${tree('live-data.ts', 3, 'file', true)}${tree('benchmarks.ts', 3, 'file')}
          ${tree('app', 0, 'dir')}${tree('src', 1, 'dir')}${tree('views', 2, 'dir')}
          ${tree('package.json', 0, 'file')}${tree('CHANGELOG.md', 0, 'file')}
        </div></div>
      <div style="flex:1;display:flex;flex-direction:column;background:var(--bg-base)">
        <div style="display:flex;border-bottom:1px solid var(--border);background:var(--bg-surface)">
          <div style="padding:9px 16px;font-size:12.5px;border-right:1px solid var(--border);background:var(--bg-base);color:var(--text);display:flex;align-items:center;gap:7px">${I.file} live-data.ts<span style="color:var(--accent)">●</span></div>
          <div style="padding:9px 16px;font-size:12.5px;color:var(--text-muted);display:flex;align-items:center;gap:7px">${I.file} router.ts</div></div>
        <div style="flex:1;padding:14px 6px;font-family:var(--font-mono);font-size:12.5px;line-height:1.75;overflow:hidden">
          ${ln(54, com('// Maintained snapshot, served straight from the repo.'))}
          ${ln(56, kw('const') + ' DEFAULT_SNAPSHOT_URL =')}
          ${ln(57, '&nbsp;&nbsp;' + str("'https://raw.githubusercontent.com/…/benchmark-data.json'") + ';')}
          ${ln(59, kw('const') + ' FETCH_TIMEOUT_MS = ' + '<span style="color:#d19a66">8_000</span>;')}
          ${ln(60, '')}
          ${ln(79, kw('export class') + ' ' + fn('LiveDataProvider') + ' {')}
          ${ln(80, '&nbsp;&nbsp;' + kw('private') + ' snapshot: BenchmarkSnapshot | ' + kw('null') + ' = ' + kw('null') + ';')}
          ${ln(122, '&nbsp;&nbsp;' + kw('async') + ' ' + fn('refresh') + '(force = ' + kw('false') + ') {')}
          ${ln(123, '&nbsp;&nbsp;&nbsp;&nbsp;' + kw('if') + ' (' + kw('this') + '.refreshing) ' + kw('return') + ' ' + kw('this') + '.refreshing;')}
          ${ln(124, '&nbsp;&nbsp;}')}
        </div></div></div>
    <div style="height:170px;border-top:1px solid var(--border);background:#0c0c10;display:flex;flex-direction:column">
      <div style="padding:7px 14px;font-size:11px;color:var(--text-muted);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:7px">${I.terminal} Terminal — bash</div>
      <div style="flex:1;padding:10px 14px;font-family:var(--font-mono);font-size:12px;line-height:1.7;color:var(--text-muted)">
        <div><span style="color:var(--success)">➜</span> <span style="color:var(--accent-2)">cascade-ai</span> npm run build -w app</div>
        <div style="color:var(--text-dim)">vite v5.4.21 building for production…</div>
        <div style="color:var(--success)">✓ 3098 modules transformed.</div>
        <div><span style="color:var(--success)">➜</span> <span style="color:var(--accent-2)">cascade-ai</span> <span style="background:var(--text);width:7px;height:14px;display:inline-block;vertical-align:middle"></span></div>
      </div></div>
  </div></div>${statusBar({ cost: '$0.0428', tokens: '18.4k', t1: 'opus-4.8', t2: 'sonnet-4.6', t3: 'haiku-4.5' })}`;
  return page(body);
}

// ─── Screen 6: Settings ──────────────────────────────────────────────────────
function settings() {
  const provRow = (name, initial, color, status, statusColor) => `<div style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-md)">
    <div style="width:32px;height:32px;border-radius:8px;background:${color};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800">${initial}</div>
    <div><div style="font-size:13px;font-weight:600">${name}</div><div style="font-size:11px;color:var(--text-dim)">${status === 'connected' ? 'Key configured · in keychain' : 'Not configured'}</div></div>
    <div style="flex:1"></div>
    <span style="font-size:11px;font-weight:600;color:${statusColor};background:color-mix(in srgb,${statusColor} 14%,transparent);padding:4px 10px;border-radius:999px">${status}</span></div>`;
  const tierSel = (tier, color, model) => `<div style="flex:1;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-md);padding:12px">
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:9px"><span style="font-size:9px;font-weight:800;color:${color};padding:2px 6px;border-radius:4px;background:color-mix(in srgb,${color} 16%,transparent)">${tier}</span><span style="font-size:11px;color:var(--text-dim)">${tier === 'T1' ? 'Administrator' : tier === 'T2' ? 'Coordinator' : 'Worker'}</span></div>
    <div style="display:flex;align-items:center;background:var(--bg-overlay);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:12px;font-family:var(--font-mono)">${model}<div style="flex:1"></div><span style="color:var(--text-dim)">▾</span></div></div>`;
  const toggle = (label, sub, on) => `<div style="display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--border)">
    <div><div style="font-size:13px">${label}</div><div style="font-size:11px;color:var(--text-dim)">${sub}</div></div><div style="flex:1"></div>
    <div style="width:36px;height:20px;border-radius:999px;background:${on ? 'var(--accent)' : 'var(--bg-active)'};position:relative"><span style="position:absolute;top:2px;${on ? 'right:2px' : 'left:2px'};width:16px;height:16px;border-radius:50%;background:#fff"></span></div></div>`;
  const section = (t) => `<div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--text-dim);margin:22px 0 12px">${t}</div>`;
  const body = `<div class="row">${activityBar('settings')}<div class="col">
    <div style="padding:11px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px"><span style="color:var(--accent)">${I.settings}</span><span style="font-weight:700;font-size:13px">Settings</span></div>
    <div style="flex:1;overflow:hidden;padding:24px 36px">
      <div style="max-width:680px;margin:0 auto">
        <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--text-dim);margin-bottom:12px">Providers</div>
        <div style="display:flex;flex-direction:column;gap:9px">
          ${provRow('Anthropic', 'A', 'linear-gradient(135deg,#c96442,#e08a6a)', 'connected', 'var(--success)')}
          ${provRow('OpenAI', 'O', 'linear-gradient(135deg,#10a37f,#1abc9c)', 'connected', 'var(--success)')}
          ${provRow('Google', 'G', 'linear-gradient(135deg,#4285f4,#3ec9d6)', 'not set', 'var(--text-dim)')}
        </div>
        ${section('Model routing — per tier')}
        <div style="display:flex;gap:10px">${tierSel('T1', 'var(--t1)', 'auto')}${tierSel('T2', 'var(--t2)', 'auto')}${tierSel('T3', 'var(--t3)', 'auto')}</div>
        ${section('Preferences')}
        ${toggle('Live benchmark data', 'Fetch latest quality scores at runtime', true)}
        ${toggle('Desktop notifications', 'Alert on approvals & task completion', true)}
        ${toggle('Auto-update', 'Download and install updates in the background', false)}
      </div></div>
  </div></div>${statusBar()}`;
  return page(body);
}

// ─── Screen 7: States sheet ──────────────────────────────────────────────────
function states() {
  const card = (title, inner) => `<div style="flex:1;display:flex;flex-direction:column"><div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--text-dim);margin-bottom:12px">${title}</div><div style="flex:1;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px;text-align:center">${inner}</div></div>`;
  const body = `<div style="flex:1;padding:40px;display:flex;flex-direction:column;overflow:hidden">
    <div style="font-size:16px;font-weight:700;margin-bottom:4px">Shared states</div>
    <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:24px">Consistent empty / loading / error / offline treatments across every view.</div>
    <div style="flex:1;display:flex;gap:18px">
      ${card('Offline (clean)', `<div style="width:56px;height:56px;border-radius:16px;background:var(--bg-raised);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;color:var(--text-dim);margin-bottom:16px"><span style="transform:scale(1.6)">${I.wifioff}</span></div><div style="font-size:15px;font-weight:700">Backend offline</div><div style="font-size:12.5px;color:var(--text-muted);margin-top:6px">Cascade runs locally. Reopen a workspace or check provider setup to reconnect.</div><div style="margin-top:16px;font-size:12px;font-weight:600;color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent-dim);border-radius:8px;padding:8px 16px">Open Settings</div>`)}
      ${card('Loading', `<div style="width:46px;height:46px;border-radius:50%;border:3px solid var(--bg-active);border-top-color:var(--accent);margin-bottom:18px"></div><div style="font-size:15px;font-weight:700">Starting engine…</div><div style="font-size:12.5px;color:var(--text-muted);margin-top:6px">Spinning up the local orchestration backend.</div><div style="margin-top:18px;width:180px;height:6px;border-radius:3px;background:var(--bg-active);overflow:hidden"><div style="height:100%;width:62%;background:linear-gradient(90deg,var(--accent),var(--accent-2))"></div></div>`)}
      ${card('Error', `<div style="width:56px;height:56px;border-radius:16px;background:var(--danger-soft);border:1px solid var(--danger);display:flex;align-items:center;justify-content:center;color:var(--danger);margin-bottom:16px">${I.alert}</div><div style="font-size:15px;font-weight:700">Something went wrong</div><div style="font-size:12.5px;color:var(--text-muted);margin-top:6px">The task failed to start. The error has been logged for review.</div><div style="display:flex;gap:8px;margin-top:16px"><span style="font-size:12px;font-weight:600;color:#fff;background:var(--danger);border-radius:8px;padding:8px 16px">Retry</span><span style="font-size:12px;font-weight:600;color:var(--text-muted);background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;padding:8px 16px">Details</span></div>`)}
    </div></div>`;
  return page(body);
}

// ─── Render all ──────────────────────────────────────────────────────────────
const screens = [
  ['1-onboarding', onboarding()],
  ['2-cockpit-empty', cockpitEmpty()],
  ['3-cockpit-active', cockpitActive()],
  ['4-chat', chat()],
  ['5-code', code()],
  ['6-settings', settings()],
  ['7-states', states()],
];

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
for (const [name, html] of screens) {
  const p = await ctx.newPage();
  await p.setContent(html, { waitUntil: 'networkidle' });
  await p.waitForTimeout(150);
  await p.screenshot({ path: path.join(OUT, `${name}.png`), clip: { x: 0, y: 0, width: W, height: H } });
  await p.close();
  console.log('rendered', name);
}
await browser.close();
console.log('done →', OUT);
