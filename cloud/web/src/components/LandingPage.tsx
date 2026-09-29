import { useState } from 'react';
import { AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  Github, Download, Copy, Check, Terminal, Monitor, Globe, Ban, RotateCcw, HelpCircle, Sparkles,
} from 'lucide-react';
import type { CloudConfig } from '../lib/api.js';
import { devLogin } from '../lib/api.js';
import CascadeMark from './CascadeMark.js';
import DownloadSection from './DownloadSection.js';
import Modal from './Modal.js';

interface Props {
  config: CloudConfig;
  onDevLogin: () => void;
}

const REPO = 'https://github.com/Varun-SV/Cascade-AI';
const NPM = 'npm i -g cascade-ai';

// Each tier as a single arc, shallower as it falls: the mark, taken apart.
const TIER_STEPS = [
  { name: 'Plans', body: 'A frontier model reads the request and splits it into sections.', d: 'M4 4 Q28 22 52 4', color: 'rgb(var(--c-t1))' },
  { name: 'Manages', body: 'Mid-size models run each section and coordinate its workers.', d: 'M12 4 Q28 18 44 4', color: 'rgb(var(--c-t2))' },
  { name: 'Works', body: 'Small, fast models do the actual work, in parallel.', d: 'M20 4 Q28 12 36 4', color: 'rgb(var(--c-t3))' },
];

const RECEIPT = [
  { tier: 'T1', model: 'claude-sonnet-4.5', cost: '0.0210' },
  { tier: 'T2', model: 'gpt-5.4-mini', cost: '0.0120' },
  { tier: 'T3', model: 'gemini-2.5-flash', cost: '0.0080' },
];

/**
 * The three moments no other orchestrator shows you — the product's actual
 * differentiators, which a graph-and-logs pitch never mentions.
 */
const MOMENTS = [
  {
    icon: Ban,
    title: 'Work that was skipped, and why',
    body: 'When a section fails, everything downstream of it is skipped rather than run into the same wall — and it cost you nothing.',
    rows: [['Implement API', 'FAILED'], ['Integration tests', 'BLOCKED']],
  },
  {
    icon: RotateCcw,
    title: 'Runs that survive an interruption',
    body: 'Hit the budget cap, cancel, or lose the process: finished sections are kept, and Continue re-plans only what is left.',
    rows: [['Research competitors', 'DONE'], ['Draft the report', 'REMAINING']],
  },
  {
    icon: HelpCircle,
    title: 'The reason behind every choice',
    body: '“Why?” explains each routing decision and what it saved against running the whole thing on a frontier model.',
    rows: [['Table extraction', 'gpt-5-mini'], ['Final synthesis', 'sonnet']],
  },
];

const SURFACES = [
  { icon: Terminal, name: 'CLI', body: 'The full orchestrator in your terminal.', link: 'Install', href: '/docs#quickstart' },
  { icon: Monitor, name: 'Desktop', body: 'Chat, a live agent tree, an editor and a browser.', link: 'Download', href: '#download' },
  { icon: Globe, name: 'Web', body: 'Nothing to install. Bring your keys.', link: 'Open', href: null },
];

function Dot({ tier }: { tier: string }) {
  const bg = tier === 'T1' ? 'bg-t1' : tier === 'T2' ? 'bg-t2' : 'bg-t3';
  return <span className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${bg}`} />;
}

export default function LandingPage({ config, onDevLogin }: Props) {
  const [devName, setDevName] = useState('');
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [copied, setCopied] = useState(false);
  const canSignIn = config.githubEnabled || config.googleEnabled;
  // Known on the first render, so the arcs never play a frame for someone
  // who asked for less motion (useReducedMotion reads synchronously).
  const reduced = useReducedMotion() ?? false;

  async function handleDevLogin() {
    setBusy(true);
    try { await devLogin(devName.trim() || 'Dev User'); onDevLogin(); }
    finally { setBusy(false); }
  }

  function copyNpm() {
    void navigator.clipboard?.writeText(NPM).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }, () => {});
  }

  const plans = [
    {
      name: 'Free',
      features: ['20 runs a day', '1 run at a time', 'Web search and fetch', ...(config.remoteBrowserEnabled ? ['5 browser sessions a day'] : [])],
    },
    {
      name: 'Pro',
      features: ['200 runs a day', '3 runs at a time', 'Priority routing', ...(config.remoteBrowserEnabled ? ['50 browser sessions a day'] : [])],
    },
  ];

  const h2 = 'm-0 mb-7 max-w-[18ch] font-serif text-[clamp(30px,4vw,44px)] font-normal leading-[1.1] tracking-[-0.02em] text-ink-50';
  const lnk = 'text-[14px] text-accent-500 hover:underline';

  return (
    <div className="h-dvh overflow-y-auto bg-paper text-ink-50">
      <header className="sticky top-0 z-20 border-b border-elev/10 bg-paper">
        <div className="mx-auto flex h-16 max-w-[1080px] items-center gap-[22px] px-6">
          <span className="flex items-center gap-[9px]">
            <CascadeMark size={24} animate={false} />
            <b className="font-serif text-[20px] font-medium tracking-[-0.01em]">Cascade</b>
          </span>
          <nav className="hidden gap-[18px] text-[14px] sm:flex">
            <a href="#how" className="text-ink-300 hover:text-ink-50">How it works</a>
            <a href="/docs" className="text-ink-300 hover:text-ink-50">Docs</a>
            <a href="#pricing" className="text-ink-300 hover:text-ink-50">Pricing</a>
            <a href={REPO} target="_blank" rel="noopener noreferrer" className="text-ink-300 hover:text-ink-50">GitHub</a>
          </nav>
          <span className="flex-1" />
          <button type="button" onClick={() => setSigningIn(true)} className="cz-btn cz-btn-quiet">Sign in</button>
          <button type="button" onClick={() => setSigningIn(true)} className="cz-btn max-[400px]:hidden">Try Cascade</button>
        </div>
      </header>

      <div className="mx-auto max-w-[1080px] px-6">
        <section className="grid items-center gap-12 pb-10 pt-12 min-[881px]:grid-cols-[1.1fr_0.9fr] min-[881px]:pt-[72px]">
          <div>
            <h1 className="m-0 mb-[18px] font-serif text-[clamp(42px,6.2vw,72px)] font-normal leading-[1.02] tracking-[-0.03em]">
              One prompt.<br />A whole organization.
            </h1>
            <p className="m-0 mb-7 max-w-[40ch] text-[18px] leading-[1.55] text-ink-300">
              Cascade plans the work, hands each part to the right model, and shows you what that saved.
            </p>
            <div className="flex flex-wrap items-center gap-2.5">
              <button type="button" onClick={() => setSigningIn(true)} className="cz-btn h-11 px-5 text-[15px]">Try Cascade</button>
              <a href="#download" className="cz-btn cz-btn-ghost h-11 px-5 text-[15px]"><Download size={14} /> Download</a>
            </div>
            <button
              type="button"
              onClick={copyNpm}
              title="Copy"
              className="mt-[18px] inline-flex items-center gap-2 rounded-lg bg-sunk px-2.5 py-1.5 font-mono text-[12.5px] text-ink-300"
            >
              {NPM} {copied ? <Check size={14} className="text-success-500" /> : <Copy size={14} />}
              <span className="sr-only">{copied ? 'Copied' : 'Copy the install command'}</span>
            </button>
          </div>

          <div aria-label="Example run" className="flex flex-col gap-4 rounded-[22px] bg-card p-[22px] shadow-[var(--glass-shadow)]">
            <div className="max-w-[90%] self-end rounded-xl bg-bubble px-3.5 py-2.5 text-[14.5px]">
              Build a competitor report and export it as a Word doc
            </div>
            <svg viewBox="0 0 320 170" role="img" aria-label="Three tiers falling: T1 plans, T2 manages, T3 works" className="block h-auto w-full">
              {[
                { d: 'M20 30 Q160 110 300 30', c: 'rgb(var(--c-t1))', delay: '0s' },
                { d: 'M65 85 Q160 150 255 85', c: 'rgb(var(--c-t2))', delay: '.35s' },
                { d: 'M112 132 Q160 166 208 132', c: 'rgb(var(--c-t3))', delay: '.7s' },
              ].map((a) => (
                <path
                  key={a.d}
                  d={a.d}
                  pathLength={1}
                  fill="none"
                  stroke={a.c}
                  strokeWidth={5}
                  strokeLinecap="round"
                  strokeDasharray={1}
                  className={reduced ? undefined : 'cz-arc'}
                  style={reduced ? undefined : { animationDelay: a.delay }}
                />
              ))}
            </svg>
            <div className="flex flex-wrap justify-center gap-4 font-mono text-[12px] text-ink-300">
              <span className="inline-flex items-center gap-1.5"><Dot tier="T1" />T1 plans</span>
              <span className="inline-flex items-center gap-1.5"><Dot tier="T2" />T2 ×4</span>
              <span className="inline-flex items-center gap-1.5"><Dot tier="T3" />T3 ×9</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-elev/10 pt-3 font-mono text-[12.5px] text-ink-300">
              <span>competitor-report.docx</span>
              <span><b className="font-medium text-success-300">saved $0.34</b> · 89% vs all-T1</span>
            </div>
          </div>
        </section>

        <section id="how" className="scroll-mt-20 pt-[88px]">
          <h2 className={h2}>Each tier does what it's best at.</h2>
          <div className="grid gap-6 min-[761px]:grid-cols-3 min-[761px]:gap-8">
            {TIER_STEPS.map((t) => (
              <div key={t.name}>
                <svg viewBox="0 0 56 28" aria-hidden="true" className="h-7 w-14">
                  <path d={t.d} fill="none" stroke={t.color} strokeWidth={3.5} strokeLinecap="round" />
                </svg>
                <h3 className="mb-1.5 mt-3 text-[16px] font-semibold">{t.name}</h3>
                <p className="m-0 leading-[1.55] text-ink-300">{t.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="pt-[88px]">
          <div className="grid items-center gap-12 min-[881px]:grid-cols-[0.9fr_1.1fr]">
            <div>
              <h2 className={h2}>Every answer comes with a receipt.</h2>
              <p className="m-0 max-w-[36ch] text-[17px] leading-[1.6] text-ink-300">
                See which model did what, and what delegating saved against running it all on the top model.
              </p>
            </div>
            <div className="flex flex-col gap-2.5 rounded-[18px] bg-card px-[22px] py-5 font-mono text-[13px] shadow-[var(--glass-shadow)]">
              {RECEIPT.map((r) => (
                <div key={r.tier} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 text-ink-300">
                  <span className="inline-flex items-center gap-1.5"><Dot tier={r.tier} />{r.tier}</span>
                  <span>{r.model}</span>
                  <span>${r.cost}</span>
                </div>
              ))}
              <div className="flex flex-wrap justify-between gap-2 border-t border-dashed border-elev/[0.17] pt-3">
                <span>total $0.0410 · all-T1 $0.3810</span>
                <b className="font-medium text-success-300">saved 89%</b>
              </div>
            </div>
          </div>
        </section>

        <section className="pt-[88px]">
          <h2 className={h2}>What other orchestrators hide.</h2>
          <div className="grid gap-6 min-[761px]:grid-cols-3 min-[761px]:gap-8">
            {MOMENTS.map((m) => (
              <div key={m.title} className="flex flex-col gap-2">
                <m.icon size={20} className="text-ink-300" />
                <h3 className="m-0 mt-1 text-[16px] font-semibold">{m.title}</h3>
                <p className="m-0 leading-[1.55] text-ink-300">{m.body}</p>
                <div className="mt-1 flex flex-col gap-1 font-mono text-[12px] text-ink-500">
                  {m.rows.map(([label, state]) => (
                    <span key={label} className="flex justify-between gap-3 border-b border-elev/10 py-1 last:border-0">
                      <span className="truncate text-ink-300">{label}</span><span>{state}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="pt-[88px]">
          <h2 className={h2}>Wherever you work.</h2>
          <div className="grid border-t border-elev/10 min-[761px]:grid-cols-3">
            {SURFACES.map((s) => (
              <div key={s.name} className="flex flex-col gap-2 py-6 pr-6">
                <b className="flex items-center gap-2 text-[16px] font-semibold"><s.icon size={17} /> {s.name}</b>
                <p className="m-0 text-ink-300">{s.body}</p>
                {s.href ? (
                  <a href={s.href} className={`${lnk} self-start`}>{s.link} →</a>
                ) : (
                  <button type="button" onClick={() => setSigningIn(true)} className={`${lnk} self-start`}>{s.link} →</button>
                )}
              </div>
            ))}
          </div>
        </section>

        <DownloadSection reduced={reduced} />

        <section id="pricing" className="scroll-mt-20 pt-[72px]">
          <h2 className={h2}>Free to start.</h2>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))]">
            {plans.map((p) => (
              <div
                key={p.name}
                className="flex flex-col gap-3 rounded-2xl bg-card p-[18px]"
                style={{ boxShadow: p.name === 'Pro' ? 'inset 0 0 0 1.5px rgb(var(--c-accent-500))' : 'inset 0 0 0 1px rgb(var(--c-elev) / 0.17)' }}
              >
                <h3 className="m-0 font-serif text-[22px] font-medium">{p.name}</h3>
                <ul className="m-0 flex list-none flex-col gap-[7px] p-0 text-[13.5px] text-ink-300">
                  {p.features.map((f) => (
                    <li key={f} className="flex gap-2"><Check size={14} className="mt-[3px] shrink-0 text-t3" />{f}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[13px] text-ink-500">You bring your own API keys and pay providers directly. The desktop app is free, always.</p>
        </section>

        <footer className="mt-24 flex flex-wrap items-center gap-4 border-t border-elev/10 pb-9 pt-7 text-[13px] text-ink-500">
          <CascadeMark size={16} animate={false} />
          <span>© 2026 Varun SV · MIT</span>
          <span className="flex-1" />
          <a href="/docs" className="text-ink-300 hover:text-ink-50">Docs</a>
          <a href="/docs#privacy" className="text-ink-300 hover:text-ink-50">Privacy</a>
          <a href={REPO} target="_blank" rel="noopener noreferrer" className="text-ink-300 hover:text-ink-50">GitHub</a>
        </footer>
      </div>

      <AnimatePresence>
        {signingIn && (
          <Modal title="Sign in to Cascade" onClose={() => setSigningIn(false)} maxWidth="max-w-[400px]">
            <div className="flex flex-col gap-2.5 px-5 pb-5 pt-1.5">
              <p className="m-0 mb-1 text-[14px] text-ink-300">Free to start. You bring your own API keys.</p>
              {config.githubEnabled && (
                <a href="/auth/github" className="cz-btn h-11"><Github size={17} /> Continue with GitHub</a>
              )}
              {config.googleEnabled && (
                <a href="/auth/google" className="cz-btn cz-btn-ghost h-11">Continue with Google</a>
              )}
              {!canSignIn && !config.devLoginEnabled && (
                <p className="m-0 text-[14px] text-ink-500">No sign-in methods are configured yet.</p>
              )}
              {config.devLoginEnabled && (
                <div className={canSignIn ? 'mt-2 border-t border-elev/10 pt-4' : ''}>
                  <p className="m-0 mb-2 text-[12px] text-ink-500">Local development only</p>
                  <div className="flex gap-2">
                    <input
                      className="cz-field h-9 flex-1 text-[14px]"
                      placeholder="Your name"
                      value={devName}
                      onChange={(e) => setDevName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void handleDevLogin(); }}
                    />
                    <button type="button" disabled={busy} onClick={() => void handleDevLogin()} className="cz-btn h-9">
                      <Sparkles size={13} /> Dev login
                    </button>
                  </div>
                </div>
              )}
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}
