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
    id: 'api',
    title: 'OpenAI-compatible API',
    html: `
      <p>Anything that already speaks to OpenAI can speak to Cascade. Point your client's
      <code>base_url</code> at this server's <code>/v1</code> and use a Cascade access token as
      the API key — <code>POST /v1/chat/completions</code> and <code>GET /v1/models</code> work
      with the official SDKs, streaming and non-streaming.</p>
      <p>The one difference is <code>model</code>: Cascade picks a model per subtask, so the
      name selects a <b>routing mode</b> rather than a model.</p>
      <ul>
        <li><code>cascade</code> — full orchestration, balanced quality against cost.</li>
        <li><code>cascade-fast</code> — one mid-tier model, no orchestration.</li>
        <li><code>cascade-quality</code> — full orchestration, biased to quality.</li>
      </ul>
      <p>Anything else returns a <code>model_not_found</code> error rather than quietly running
      something you didn't ask for. Each reply carries the usual <code>usage</code> block plus a
      <code>cascade</code> object naming the tier and model that actually served it, and what the
      routing saved. Tools, function calling and <code>n &gt; 1</code> aren't supported yet —
      unsupported parameters are rejected rather than ignored.</p>`,
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
  /* Cascade "Calm": warm paper in light, midnight in dark. The tier ramp
     (azure → sky → teal) is the only accent, used for the mark and the spine. */
  :root{
    --bg:#f7f6f2;--panel:#efede7;--ink:#15171c;--muted:#555a63;--line:rgba(21,23,28,.12);
    --code:#eae8e1;--link:#2f6fe4;--btn:#15171c;--btn-ink:#f7f6f2;
    --azure:#4C8DFF;--sky:#38B0DE;--teal:#2DD4BF;
  }
  @media(prefers-color-scheme:dark){:root{
    --bg:#0e1117;--panel:#161a22;--ink:#e9ebf0;--muted:#a2a8b4;--line:rgba(233,235,240,.1);
    --code:#1b2029;--link:#6fa3ff;--btn:#e9ebf0;--btn-ink:#0e1117;color-scheme:dark}}
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:16px/1.65 "Geist",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased}
  h1,h2{font-family:"Source Serif 4",Georgia,"Times New Roman",serif;font-weight:500}
  a{color:var(--link);text-decoration:none}
  a:hover{text-decoration:underline}
  code{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em;
    background:var(--code);border-radius:5px;padding:.1em .38em}
  .t1{color:var(--azure)} .t2{color:var(--sky)} .t3{color:var(--teal)}
  header{border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:10}
  .bar{max-width:1080px;margin:0 auto;display:flex;align-items:center;gap:10px;padding:14px 24px}
  .mark{display:block;width:22px;height:22px}
  .mark path{fill:none;stroke-width:2.1;stroke-linecap:round}
  .brand{font-family:"Source Serif 4",Georgia,serif;font-size:1.25rem;font-weight:500;letter-spacing:-.01em}
  .brand span{color:var(--muted);font-family:inherit;font-size:.95rem;margin-left:6px}
  .cta{margin-left:auto;font-size:.9rem;font-weight:500;color:var(--btn-ink);
    background:var(--btn);padding:8px 14px;border-radius:10px}
  .cta:hover{text-decoration:none;opacity:.9}
  .hero{max-width:1080px;margin:0 auto;padding:56px 24px 8px}
  .hero h1{font-size:2.6rem;line-height:1.1;margin:0 0 10px;letter-spacing:-.025em}
  .hero p{color:var(--muted);max-width:56ch;margin:0;font-size:1.05rem}
  .wrap{max-width:1080px;margin:0 auto;display:grid;grid-template-columns:220px 1fr;gap:40px;padding:28px 24px 80px}
  nav{position:sticky;top:74px;align-self:start;display:flex;flex-direction:column;gap:2px;font-size:.92rem}
  nav a{color:var(--muted);padding:6px 10px;border-radius:8px}
  nav a:hover{color:var(--ink);background:var(--panel);text-decoration:none}

  /* The spine. Same device as the app's live run and the landing page: one
     line of the tier ramp running down the content with a tier-coloured node
     per section, so every public surface descends the same way. */
  main{min-width:0;position:relative;padding-left:26px;max-width:68ch}
  main::before{content:"";position:absolute;left:0;top:6px;bottom:0;width:2px;border-radius:2px;
    background:linear-gradient(to bottom,var(--azure),var(--sky),var(--teal))}
  section{padding:8px 0 28px;position:relative}
  section::before{content:"";position:absolute;left:-30px;top:18px;width:10px;height:10px;
    border-radius:50%;background:var(--sky);box-shadow:0 0 0 3px var(--bg)}
  section:nth-child(3n+1)::before{background:var(--azure)}
  section:nth-child(3n+3)::before{background:var(--teal)}
  section h2{font-size:1.6rem;margin:0 0 10px;letter-spacing:-.015em}
  section p{margin:0 0 12px} ul,ol{margin:0 0 12px;padding-left:22px} li{margin:4px 0}
  footer{border-top:1px solid var(--line);color:var(--muted);font-size:.86rem;text-align:center;padding:26px 24px}

  @media(max-width:760px){
    .wrap{grid-template-columns:1fr;gap:8px;padding:20px 18px 60px}
    nav{position:static;flex-flow:row wrap}
    .hero{padding:36px 18px 4px}
    .hero h1{font-size:2rem}
    .bar{padding:12px 18px}
    /* The full spine costs horizontal room a phone doesn't have; the section
       nodes carry the same idea in less of it. */
    main{padding-left:18px}
    section::before{left:-22px}
  }
  @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style>
</head>
<body>
<header>
  <div class="bar">
    <svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5 Q12 14.5 20.5 7.5" stroke="#4C8DFF"/><path d="M6.25 12.5 Q12 17.75 17.75 12.5" stroke="#38B0DE"/><path d="M9 17.5 Q12 20.5 15 17.5" stroke="#2DD4BF"/></svg>
    <span class="brand">Cascade<span>Docs</span></span>
    <a class="cta" href="/">Open the app</a>
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
<footer>Cascade — multi-tier AI orchestration · <a href="/">Open the app</a> · <a href="/#download">Download the desktop app</a> · <a href="/#tiers">How the tiers work</a> · <a href="https://github.com/Varun-SV/Cascade-AI">GitHub</a></footer>
</body>
</html>`;
}
