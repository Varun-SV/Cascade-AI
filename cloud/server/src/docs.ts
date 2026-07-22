// Public documentation site, served at /docs by the cloud server (before the
// SPA catch-all). It is a single self-contained HTML page — inline CSS, no
// external fonts or scripts — so it works under a strict origin, renders fast,
// and is safe to cache. The content is user-facing product docs written here on
// purpose: the repo's docs/*.md are internal design/security specs and must NOT
// be served publicly.

interface Section {
  id: string;
  title: string;
  html: string;
}

const SECTIONS: Section[] = [
  {
    id: 'what',
    title: 'What is Cascade',
    html: `
      <p>Cascade is a multi-tier AI orchestrator. Instead of sending every request to one
      expensive model, it routes work across three tiers:</p>
      <ul>
        <li><b class="t1">Tier 1 — Administrator</b> plans the task and delegates.</li>
        <li><b class="t2">Tier 2 — Supervisor</b> breaks work down and coordinates.</li>
        <li><b class="t3">Tier 3 — Worker</b> does the actual generation.</li>
      </ul>
      <p>Simple asks are answered directly; complex ones fan out across the tiers. You bring
      your own provider API keys, so you pay providers directly and your data stays yours.
      Cascade runs in three places that share the same account: the <b>web app</b>, a
      <b>desktop app</b>, and a <b>CLI</b>.</p>`,
  },
  {
    id: 'quickstart',
    title: 'Quick start',
    html: `
      <p>Sign in at the web app, then:</p>
      <ol>
        <li>Open <b>Settings → API keys</b> and add a key for at least one provider
          (OpenAI, Anthropic, Google, Azure, or any OpenAI-compatible endpoint).</li>
        <li>Type a request in the composer and send. Cascade picks the tiers and models.</li>
        <li>Watch the run: each answer shows which tier and model handled it, and
          <b>Why?</b> explains the routing and what it saved versus running everything on
          the top model.</li>
      </ol>
      <p>Prefer the terminal or a native app? The <b>CLI</b> and <b>desktop app</b> use the
      same account and sync your keys and chats.</p>`,
  },
  {
    id: 'keys',
    title: 'Providers & API keys',
    html: `
      <p>Cascade is bring-your-own-key. Add keys under <b>Settings → API keys</b>. Keys are
      encrypted on your device before they are stored, and account sync moves them between
      your devices end-to-end encrypted — the server relays ciphertext it cannot read.</p>
      <p>Each provider exposes its live model list once a key is set, so you always pick from
      models the provider actually serves. Optional <b>web search</b> can be enabled per chat
      with your own search key, or falls back to a keyless provider.</p>`,
  },
  {
    id: 'tiers',
    title: 'How the tiers route',
    html: `
      <p>Every tier can be set to a specific model or to <b>Cascade Auto</b>. Auto ranks the
      models your providers actually serve by a benchmark-quality score against price, so a
      cheaper model that is good enough wins the cheap work and the strongest model is saved
      for the hard work. Newly released models are scored by their class until the benchmark
      table catches up, so a better-value new model isn't invisible.</p>
      <p>Pin a model to a tier and that pin is authoritative — Auto only applies to tiers you
      leave on Auto. You can also cap a run's spend and token budget in Settings, and force a
      single tier for a one-off request.</p>`,
  },
  {
    id: 'files',
    title: 'Files & document exports',
    html: `
      <p>Ask for a file and Cascade delivers one. A run streams text, so the model writes the
      source and your browser renders the real binary on download — nothing is rendered on a
      server and your content never leaves the client:</p>
      <ul>
        <li><b>PDF</b> and <b>Word</b> from Markdown (headings, lists, tables, code, quotes),
          with selectable text.</li>
        <li><b>Excel</b> from CSV — a real <code>.xlsx</code> workbook.</li>
        <li><b>PowerPoint</b> from a Markdown deck — slides split on <code>---</code>, each
          led by a heading.</li>
      </ul>
      <p>Every generated file can be <b>viewed</b>, <b>downloaded</b> for free, or <b>saved</b>
      to your Cascade storage (metered by plan). Plain code, CSV, JSON and Markdown files work
      the same way.</p>`,
  },
  {
    id: 'privacy',
    title: 'Privacy & your keys',
    html: `
      <p>Your provider keys stay yours: encrypted on-device, synced end-to-end, and used to
      call providers directly. Document rendering (PDF/Office) happens entirely in your
      browser. You can delete any chat or file at any time, and clear everything from
      Settings. Saved files live in your own per-account storage.</p>`,
  },
];

function nav(): string {
  return SECTIONS.map((s) => `<a href="#${s.id}">${s.title}</a>`).join('');
}

function body(): string {
  return SECTIONS.map(
    (s) => `<section id="${s.id}"><h2>${s.title}</h2>${s.html}</section>`,
  ).join('\n');
}

/** The full self-contained /docs HTML document. */
export function renderDocsPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cascade — Documentation</title>
<meta name="description" content="Documentation for Cascade, the multi-tier AI orchestrator: providers & keys, tier routing, file exports, and privacy." />
<style>
  :root{
    --bg:#0b0c10;--panel:#111318;--ink:#e7e9ee;--muted:#9aa0ab;--line:#23262e;
    --azure:#4C8DFF;--sky:#38B0DE;--teal:#2DD4BF;
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased}
  a{color:var(--sky);text-decoration:none}
  a:hover{text-decoration:underline}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;
    background:#1a1d24;border:1px solid var(--line);border-radius:5px;padding:.08em .35em}
  .t1{color:var(--azure)} .t2{color:var(--sky)} .t3{color:var(--teal)}
  header{border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(11,12,16,.85);
    backdrop-filter:blur(10px);z-index:10}
  .bar{max-width:1080px;margin:0 auto;display:flex;align-items:center;gap:12px;padding:14px 24px}
  .mark{display:flex;gap:3px;align-items:flex-end;height:22px}
  .mark span{width:6px;border-radius:2px}
  .mark span:nth-child(1){height:10px;background:var(--azure)}
  .mark span:nth-child(2){height:16px;background:var(--sky)}
  .mark span:nth-child(3){height:22px;background:var(--teal)}
  .brand{font-weight:700;letter-spacing:-.01em}
  .brand em{font-style:normal;background:linear-gradient(90deg,var(--azure),var(--sky),var(--teal));
    -webkit-background-clip:text;background-clip:text;color:transparent}
  .cta{margin-left:auto;font-size:.9rem;font-weight:600;color:#fff;
    background:linear-gradient(90deg,var(--azure),var(--teal));padding:8px 14px;border-radius:9px}
  .cta:hover{text-decoration:none;filter:brightness(1.07)}
  .hero{max-width:1080px;margin:0 auto;padding:52px 24px 8px}
  .hero h1{font-size:2.2rem;margin:0 0 8px;letter-spacing:-.02em}
  .hero p{color:var(--muted);max-width:60ch;margin:0}
  .wrap{max-width:1080px;margin:0 auto;display:grid;grid-template-columns:220px 1fr;gap:40px;padding:28px 24px 80px}
  nav{position:sticky;top:74px;align-self:start;display:flex;flex-direction:column;gap:2px;font-size:.92rem}
  nav a{color:var(--muted);padding:6px 10px;border-radius:7px;border-left:2px solid transparent}
  nav a:hover{color:var(--ink);background:var(--panel);text-decoration:none}
  main{min-width:0}
  section{padding:8px 0 26px;border-bottom:1px solid var(--line)}
  section:last-child{border-bottom:0}
  section h2{font-size:1.4rem;margin:0 0 10px;letter-spacing:-.01em}
  section p{margin:0 0 12px} ul,ol{margin:0 0 12px;padding-left:22px} li{margin:4px 0}
  footer{border-top:1px solid var(--line);color:var(--muted);font-size:.86rem;text-align:center;padding:26px 24px}
  @media(max-width:760px){.wrap{grid-template-columns:1fr;gap:8px}nav{position:static;flex-flow:row wrap}}
</style>
</head>
<body>
<header>
  <div class="bar">
    <span class="mark"><span></span><span></span><span></span></span>
    <span class="brand"><em>Cascade</em> Docs</span>
    <a class="cta" href="/">Launch app →</a>
  </div>
</header>
<div class="hero">
  <h1>Cascade documentation</h1>
  <p>Everything you need to route work across tiers, connect your providers, and turn a chat
     into a real document.</p>
</div>
<div class="wrap">
  <nav>${nav()}</nav>
  <main>
${body()}
  </main>
</div>
<footer>Cascade — multi-tier AI orchestration · <a href="/">Open the app</a> · <a href="https://github.com/Varun-SV/Cascade-AI">GitHub</a></footer>
</body>
</html>`;
}
