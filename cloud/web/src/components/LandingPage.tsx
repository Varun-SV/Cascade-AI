import { useState, type CSSProperties } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Github, ArrowRight, Layers, KeyRound, Coins, FileText, Terminal, ShieldCheck,
  Download, BookOpen, Sparkles, Ban, RotateCcw, HelpCircle,
} from 'lucide-react';
import type { CloudConfig } from '../lib/api.js';
import { devLogin } from '../lib/api.js';
import { AZURE, SKY, TEAL, TIERS } from '../lib/brand.js';
import CascadeSpine from './CascadeSpine.js';
import RunDiagram from './RunDiagram.js';

interface Props {
  config: CloudConfig;
  onDevLogin: () => void;
}

const RELEASES = 'https://github.com/Varun-SV/Cascade-AI/releases/latest';
const REPO = 'https://github.com/Varun-SV/Cascade-AI';

/** Sections the spine tracks, top to bottom. */
const SPINE_SECTIONS = ['tiers', 'visible', 'surfaces', 'features'] as const;

/** The three-bar cascade mark (azure → sky → teal), matching the /docs page. */
function Mark({ size = 22 }: { size?: number }) {
  const unit = size / 22;
  return (
    <span className="inline-flex items-end gap-[3px]" style={{ height: size }} aria-hidden>
      <span style={{ width: 6 * unit, height: 10 * unit, borderRadius: 2, background: AZURE }} />
      <span style={{ width: 6 * unit, height: 16 * unit, borderRadius: 2, background: SKY }} />
      <span style={{ width: 6 * unit, height: 22 * unit, borderRadius: 2, background: TEAL }} />
    </span>
  );
}

/**
 * The three moments no other orchestrator shows you. These are the product's
 * actual differentiators and the old landing mentioned none of them — it sold
 * "a graph, a timeline, logs", which every agent framework has.
 */
const MOMENTS = [
  {
    icon: Ban,
    color: AZURE,
    title: 'Work that was skipped, and why',
    body: 'When a section fails, everything downstream of it is skipped rather than run into the same wall. You see which upstream failed and that the skipped work cost you nothing.',
    demo: (
      <div className="space-y-1.5 text-[11px]">
        <Row tone="fail" label="Implement API" right="FAILED" />
        <Row tone="block" label="Integration tests" right="BLOCKED" />
        <p className="pt-0.5 text-ink-500">Blocked by: Implement API · 0 tokens spent</p>
      </div>
    ),
  },
  {
    icon: RotateCcw,
    color: SKY,
    title: 'Runs that survive an interruption',
    body: 'Hit the budget cap, cancel, or lose the process entirely — the finished sections are checkpointed. Continue picks up where it stopped instead of paying for the same work twice.',
    demo: (
      <div className="space-y-1.5 text-[11px]">
        <Row tone="done" label="Research competitors" right="DONE" />
        <Row tone="done" label="Gather pricing" right="DONE" />
        <Row tone="idle" label="Draft the report" right="REMAINING" />
        <p className="pt-0.5 text-ink-500">/continue → re-plans only what is left</p>
      </div>
    ),
  },
  {
    icon: HelpCircle,
    color: TEAL,
    title: 'The reason behind every choice',
    body: 'Each answer shows the tier and model that produced it. “Why?” explains the routing decision and what it saved against running the whole thing on a frontier model.',
    demo: (
      <div className="space-y-1.5 text-[11px]">
        <Row tone="done" label="Table extraction" right="gpt-5-mini" />
        <Row tone="done" label="Final synthesis" right="sonnet" />
        <p className="pt-0.5 text-ink-500">$0.04 vs $0.38 all-frontier · 89% saved</p>
      </div>
    ),
  },
];

function Row({ tone, label, right }: { tone: 'done' | 'fail' | 'block' | 'idle'; label: string; right: string }) {
  const color = tone === 'done' ? TEAL : tone === 'fail' ? '#F87171' : tone === 'block' ? '#FBBF24' : undefined;
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-elev/10 px-2 py-1.5">
      <span className="truncate text-ink-300">{label}</span>
      <span className="shrink-0 font-semibold tabular-nums" style={{ color: color ?? 'rgb(var(--c-ink-500))' }}>{right}</span>
    </div>
  );
}

const FEATURES = [
  { icon: Coins, title: 'Auto-routing that saves money', body: 'Cascade Auto ranks the models your providers serve by benchmark quality against price, so cheap work goes to cheap models and only the hard work reaches the frontier ones.' },
  { icon: KeyRound, title: 'Bring your own keys', body: 'Add your own provider keys — encrypted on your device, synced between your devices end-to-end. You pay providers directly; nothing is stored on our servers in the clear.' },
  { icon: FileText, title: 'Real document exports', body: 'Ask for a report and download a genuine PDF, Word, Excel or PowerPoint — rendered in your browser from the model’s output, never on a server.' },
  { icon: Layers, title: 'Parallel by default', body: 'Independent sections run at the same time; dependent ones wait. The plan is compiled into a graph, so ordering comes from the work rather than from luck.' },
  { icon: Terminal, title: 'Web, desktop & CLI', body: 'One account across a polished web app, a native desktop app, and a terminal CLI — your keys, chats and settings follow you.' },
  { icon: ShieldCheck, title: 'Yours to control', body: 'Cap a run’s spend and token budget, pin a model to a tier, delete any chat or file, and clear everything whenever you want.' },
];

const SURFACES = [
  { icon: Terminal, name: 'CLI', body: 'The full orchestrator in your terminal. Watch tiers stream, approve tool calls, resume with /continue.' },
  { icon: Layers, name: 'Desktop', body: 'A native app with the run graph, timeline, artifacts and diff review side by side.' },
  { icon: BookOpen, name: 'Web', body: 'Nothing to install. Same account, same keys, same chats — in any browser.' },
];

export default function LandingPage({ config, onDevLogin }: Props) {
  const [devName, setDevName] = useState('');
  const [busy, setBusy] = useState(false);
  const canSignIn = config.githubEnabled || config.googleEnabled;

  // A run diagram and a scroll-driven spine are exactly the kind of motion that
  // makes people ill, so the preference has to be known on the FIRST render.
  // Reading matchMedia in an effect defaulted to `false`, which meant Framer and
  // RunDiagram both mounted in animated mode and played a frame of animation
  // before the setting was applied — the one frame the user asked not to see.
  // useReducedMotion subscribes and reads synchronously (and is SSR-safe).
  const reduced = useReducedMotion() ?? false;

  async function handleDevLogin() {
    setBusy(true);
    try { await devLogin(devName.trim() || 'Dev User'); onDevLogin(); }
    finally { setBusy(false); }
  }

  const signInButtons = (
    <div className="flex flex-col gap-2.5 sm:flex-row sm:justify-center">
      {config.githubEnabled && (
        <a href="/auth/github" className="accent-grad flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-accent-700/25 transition hover:brightness-110">
          <Github size={17} /> Continue with GitHub
        </a>
      )}
      {config.googleEnabled && (
        <a href="/auth/google" className="flex items-center justify-center gap-2 rounded-xl border border-elev/15 bg-elev/[0.05] px-5 py-3 text-sm font-semibold text-ink-100 transition hover:bg-elev/[0.1]">
          Continue with Google
        </a>
      )}
      {!canSignIn && !config.devLoginEnabled && (
        <p className="text-sm text-ink-400">No sign-in methods are configured yet.</p>
      )}
    </div>
  );

  // Reveal-on-scroll, disabled wholesale under reduced motion so nothing waits
  // on an animation that will never play.
  const reveal = reduced
    ? {}
    : {
      initial: { opacity: 0, y: 18 },
      whileInView: { opacity: 1, y: 0 },
      viewport: { once: true, margin: '-60px' },
      transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] as const },
    };

  return (
    <div className="h-dvh overflow-y-auto text-ink-100">
      {/* Top bar */}
      <header className="sticky top-0 z-20 border-b border-elev/10 bg-ink-900/60 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-3.5">
          <Mark />
          <span className="font-semibold tracking-tight">
            <span className="bg-gradient-to-r from-[#4C8DFF] via-[#38B0DE] to-[#2DD4BF] bg-clip-text text-transparent">Cascade</span>
          </span>
          <nav className="ml-auto flex items-center gap-1 text-sm">
            <a href="/docs" className="rounded-lg px-3 py-1.5 text-ink-300 hover:bg-elev/[0.06] hover:text-ink-100">Docs</a>
            <a href={REPO} target="_blank" rel="noreferrer" className="hidden rounded-lg px-3 py-1.5 text-ink-300 hover:bg-elev/[0.06] hover:text-ink-100 sm:block">GitHub</a>
            <a href="#start" className="accent-grad ml-1 rounded-lg px-3.5 py-1.5 font-semibold text-white shadow shadow-accent-700/20 hover:brightness-110">Sign in</a>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 -top-32 mx-auto h-72 max-w-3xl rounded-full opacity-25 blur-3xl"
          style={{ background: `radial-gradient(closest-side, ${SKY}, transparent)` }} />
        <div className="mx-auto max-w-5xl px-5 pb-10 pt-16 sm:pt-24">
          <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_1fr]">
            <div className="text-center lg:text-left">
              <motion.h1
                initial={reduced ? undefined : { opacity: 0, y: 20 }} animate={reduced ? undefined : { opacity: 1, y: 0 }}
                transition={{ duration: 0.55 }}
                className="text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl"
              >
                Agents that<br />
                <span className="bg-gradient-to-r from-[#4C8DFF] via-[#38B0DE] to-[#2DD4BF] bg-clip-text text-transparent">cascade</span>
                <span className="text-ink-500">.</span>
              </motion.h1>
              <motion.p
                initial={reduced ? undefined : { opacity: 0, y: 20 }} animate={reduced ? undefined : { opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 0.08 }}
                className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-ink-300 sm:text-lg lg:mx-0"
              >
                One prompt becomes a hierarchy of agents that plan, delegate and execute in parallel —
                each step routed to the cheapest model that is genuinely good at it.
              </motion.p>

              <motion.div
                id="start"
                initial={reduced ? undefined : { opacity: 0, y: 20 }} animate={reduced ? undefined : { opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 0.16 }}
                className="mt-8 scroll-mt-24"
              >
                <div className="lg:[&>div]:justify-start">{signInButtons}</div>
                <p className="mt-3 text-xs text-ink-500">Free to start — you bring your own API keys.</p>
                <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm lg:justify-start">
                  <a href={RELEASES} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-ink-300 hover:text-ink-100">
                    <Download size={15} /> Download desktop app
                  </a>
                  <a href="/docs" className="inline-flex items-center gap-1.5 text-ink-300 hover:text-ink-100">
                    <BookOpen size={15} /> Read the docs
                  </a>
                </div>
              </motion.div>
            </div>

            <motion.div
              initial={reduced ? undefined : { opacity: 0, scale: 0.97 }} animate={reduced ? undefined : { opacity: 1, scale: 1 }}
              transition={{ duration: 0.6, delay: 0.2 }}
            >
              <RunDiagram reduced={reduced} />
            </motion.div>
          </div>
        </div>
      </section>

      {/* Everything below hangs off the spine. */}
      <div className="relative mx-auto max-w-6xl px-5 lg:pl-16">
        <CascadeSpine sectionIds={SPINE_SECTIONS} reduced={reduced} />

        {/* Tiers — each steps further right, so the section descends as it reads. */}
        <section id="tiers" className="scroll-mt-24 py-16">
          <motion.div {...reveal} className="mb-10 max-w-2xl">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">One prompt, three tiers</h2>
            <p className="mt-3 text-ink-400">
              Complexity decides how far it cascades. A trivial ask gets answered directly; a hard one fans
              out across all three.
            </p>
          </motion.div>

          <div className="space-y-4">
            {TIERS.map((t, i) => (
              <motion.div
                key={t.n}
                {...reveal}
                transition={reduced ? undefined : { ...(reveal as { transition?: object }).transition, delay: i * 0.08 }}
                className="glass rounded-2xl border-l-2 p-5 sm:p-6 lg:ml-[var(--tier-step)]"
                style={{
                  borderLeftColor: t.color,
                  // The step is a CSS variable consumed ONLY by the lg: class
                  // above. Setting marginLeft inline applied it at every width —
                  // a 375px phone still gave the third card ~30px of indent,
                  // exactly the behaviour the comment claimed it avoided.
                  '--tier-step': `${i * 3}rem`,
                } as CSSProperties}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl text-sm font-bold text-white" style={{ background: t.color }}>{t.n}</span>
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: t.color }}>Tier {t.n}</div>
                    <h3 className="text-lg font-semibold text-ink-50">{t.name}</h3>
                  </div>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-ink-300">{t.text}</p>
                <p className="mt-2 text-sm leading-relaxed text-ink-500">{t.example}</p>
              </motion.div>
            ))}
          </div>
        </section>

        {/* The differentiators. */}
        <section id="visible" className="scroll-mt-24 py-16">
          <motion.div {...reveal} className="mb-10 max-w-2xl">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">What other orchestrators hide</h2>
            <p className="mt-3 text-ink-400">
              Most agent tools show you a graph and a log. The useful questions are what got skipped, what
              survives a crash, and why this model — so Cascade answers those.
            </p>
          </motion.div>

          <div className="grid gap-4 md:grid-cols-3">
            {MOMENTS.map((m, i) => (
              <motion.div
                key={m.title}
                {...reveal}
                transition={reduced ? undefined : { ...(reveal as { transition?: object }).transition, delay: i * 0.08 }}
                className="glass flex flex-col rounded-2xl p-5"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: `${m.color}1F`, color: m.color }}>
                  <m.icon size={19} />
                </div>
                <h3 className="mt-4 font-semibold text-ink-50">{m.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-400">{m.body}</p>
                <div className="mt-4 rounded-xl border border-elev/10 bg-elev/[0.03] p-2.5">{m.demo}</div>
              </motion.div>
            ))}
          </div>
        </section>

        {/* Three surfaces. */}
        <section id="surfaces" className="scroll-mt-24 py-16">
          <motion.div {...reveal} className="mb-10 max-w-2xl">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Three surfaces, one account</h2>
            <p className="mt-3 text-ink-400">Your keys, chats and settings follow you between them.</p>
          </motion.div>
          <div className="grid gap-4 sm:grid-cols-3">
            {SURFACES.map((s, i) => (
              <motion.div
                key={s.name}
                {...reveal}
                transition={reduced ? undefined : { ...(reveal as { transition?: object }).transition, delay: i * 0.07 }}
                className="glass rounded-2xl p-5"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-500/12 text-accent-300">
                  <s.icon size={19} />
                </div>
                <h3 className="mt-4 font-semibold text-ink-50">{s.name}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-400">{s.body}</p>
              </motion.div>
            ))}
          </div>
        </section>

        {/* Features. */}
        <section id="features" className="scroll-mt-24 py-16">
          <motion.h2 {...reveal} className="mb-10 text-2xl font-bold tracking-tight sm:text-3xl">Everything else you need</motion.h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <motion.div
                key={f.title}
                {...reveal}
                transition={reduced ? undefined : { ...(reveal as { transition?: object }).transition, delay: (i % 3) * 0.06 }}
                className="glass rounded-2xl p-5"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-500/12 text-accent-300">
                  <f.icon size={19} />
                </div>
                <h3 className="mt-4 font-semibold text-ink-50">{f.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-400">{f.body}</p>
              </motion.div>
            ))}
          </div>
        </section>
      </div>

      {/* Final CTA */}
      <section className="mx-auto max-w-3xl px-5 pb-20">
        <motion.div {...reveal} className="glass-strong relative overflow-hidden rounded-3xl px-6 py-12 text-center">
          <div className="pointer-events-none absolute inset-x-0 -top-16 mx-auto h-40 max-w-md rounded-full opacity-20 blur-3xl"
            style={{ background: `radial-gradient(closest-side, ${AZURE}, transparent)` }} />
          <Mark size={30} />
          <h2 className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">Start orchestrating in a minute</h2>
          <p className="mx-auto mt-3 max-w-md text-ink-300">Sign in, add a provider key, and send your first prompt. No setup, no lock-in.</p>
          <div className="mt-7">{signInButtons}</div>

          {config.devLoginEnabled && (
            <div className="mx-auto mt-7 max-w-xs border-t border-elev/10 pt-5">
              <p className="mb-2 text-xs text-ink-400">Local development only</p>
              <div className="flex gap-2">
                <input className="flex-1 rounded-lg border border-elev/10 bg-elev/[0.04] px-3 py-1.5 text-sm text-ink-100 outline-none focus:border-accent-500/60"
                  placeholder="Your name" value={devName} onChange={(e) => setDevName(e.target.value)} />
                <button type="button" disabled={busy} onClick={handleDevLogin}
                  className="accent-grad rounded-lg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
                  <span className="inline-flex items-center gap-1"><Sparkles size={13} /> Dev login</span>
                </button>
              </div>
            </div>
          )}
        </motion.div>
      </section>

      {/* Footer */}
      <footer className="border-t border-elev/10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-5 py-6 text-sm text-ink-400 sm:flex-row">
          <span className="inline-flex items-center gap-2"><Mark size={16} /> Cascade — multi-tier AI orchestration</span>
          <div className="flex items-center gap-4">
            <a href="/docs" className="hover:text-ink-100 inline-flex items-center gap-1"><BookOpen size={14} /> Docs</a>
            <a href={REPO} target="_blank" rel="noreferrer" className="hover:text-ink-100 inline-flex items-center gap-1"><Github size={14} /> GitHub</a>
            <a href="#start" className="inline-flex items-center gap-1 hover:text-ink-100">Sign in <ArrowRight size={13} /></a>
          </div>
        </div>
      </footer>
    </div>
  );
}
