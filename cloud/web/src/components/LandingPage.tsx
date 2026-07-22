import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Github, ArrowRight, Layers, KeyRound, Coins, FileText, Terminal, ShieldCheck,
  Download, BookOpen, Sparkles,
} from 'lucide-react';
import type { CloudConfig } from '../lib/api.js';
import { devLogin } from '../lib/api.js';

interface Props {
  config: CloudConfig;
  onDevLogin: () => void;
}

const RELEASES = 'https://github.com/Varun-SV/Cascade-AI/releases/latest';
const REPO = 'https://github.com/Varun-SV/Cascade-AI';

// The three-bar cascade mark (azure → sky → teal), matching the /docs page.
function Mark({ size = 22 }: { size?: number }) {
  const unit = size / 22;
  return (
    <span className="inline-flex items-end gap-[3px]" style={{ height: size }} aria-hidden>
      <span style={{ width: 6 * unit, height: 10 * unit, borderRadius: 2, background: '#4C8DFF' }} />
      <span style={{ width: 6 * unit, height: 16 * unit, borderRadius: 2, background: '#38B0DE' }} />
      <span style={{ width: 6 * unit, height: 22 * unit, borderRadius: 2, background: '#2DD4BF' }} />
    </span>
  );
}

const TIERS = [
  { n: '1', name: 'Administrator', color: '#4C8DFF', text: 'Reads the request, plans the work, and delegates. Simple asks it answers directly.' },
  { n: '2', name: 'Supervisor', color: '#38B0DE', text: 'Breaks the plan into subtasks and coordinates the workers running in parallel.' },
  { n: '3', name: 'Worker', color: '#2DD4BF', text: 'Does the actual generation on the cheapest model that is good enough for the job.' },
];

const FEATURES = [
  { icon: Coins, title: 'Auto-routing that saves money', body: 'Cascade Auto ranks the models your providers serve by benchmark quality against price, so cheap work goes to cheap models and only the hard work reaches the frontier ones.' },
  { icon: KeyRound, title: 'Bring your own keys', body: 'Add your own provider keys — encrypted on your device, synced between your devices end-to-end. You pay providers directly; nothing is stored on our servers in the clear.' },
  { icon: FileText, title: 'Real document exports', body: 'Ask for a report and download a genuine PDF, Word, Excel or PowerPoint — rendered in your browser from the model’s output, never on a server.' },
  { icon: Layers, title: 'See every decision', body: 'Each answer shows which tier and model handled it. “Why?” explains the routing and exactly what it saved versus running everything on the top model.' },
  { icon: Terminal, title: 'Web, desktop & CLI', body: 'One account across a polished web app, a native desktop app, and a terminal CLI — your keys, chats and settings follow you.' },
  { icon: ShieldCheck, title: 'Yours to control', body: 'Cap a run’s spend and token budget, pin a model to a tier, delete any chat or file, and clear everything whenever you want.' },
];

const STATS = [
  ['90%', 'cheaper vs. all-frontier'],
  ['3', 'tiers, fully parallel'],
  ['6', 'model providers'],
  ['0', 'config to start'],
];

export default function LandingPage({ config, onDevLogin }: Props) {
  const [devName, setDevName] = useState('');
  const [busy, setBusy] = useState(false);
  const canSignIn = config.githubEnabled || config.googleEnabled;

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

  const reveal = {
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
          style={{ background: 'radial-gradient(closest-side, #38B0DE, transparent)' }} />
        <div className="mx-auto max-w-3xl px-5 pb-8 pt-20 text-center sm:pt-28">
          <motion.h1 initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55 }}
            className="text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
            Agents that<br />
            <span className="bg-gradient-to-r from-[#4C8DFF] via-[#38B0DE] to-[#2DD4BF] bg-clip-text text-transparent">cascade</span>
            <span className="text-ink-500">.</span>
          </motion.h1>
          <motion.p initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, delay: 0.08 }}
            className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-ink-300 sm:text-lg">
            One prompt becomes a self-organizing hierarchy of AI agents that plan, delegate and execute —
            auto-routing every step to the cheapest model that’s best at it.{' '}
            <strong className="text-ink-100">Up to 90% cheaper</strong> than running everything on one frontier model.
          </motion.p>

          <motion.div id="start" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, delay: 0.16 }} className="mt-8 scroll-mt-24">
            {signInButtons}
            <p className="mt-3 text-xs text-ink-500">Free to start — you bring your own API keys.</p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm">
              <a href={RELEASES} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-ink-300 hover:text-ink-100">
                <Download size={15} /> Download desktop app
              </a>
              <a href="/docs" className="inline-flex items-center gap-1.5 text-ink-300 hover:text-ink-100">
                <BookOpen size={15} /> Read the docs
              </a>
            </div>
          </motion.div>

          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6, delay: 0.3 }}
            className="mx-auto mt-12 grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
            {STATS.map(([n, label]) => (
              <div key={label} className="glass rounded-xl px-3 py-3">
                <div className="text-2xl font-bold text-ink-50">{n}</div>
                <div className="mt-0.5 text-[11px] leading-tight text-ink-400">{label}</div>
              </div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* How it cascades */}
      <section className="mx-auto max-w-6xl px-5 py-16">
        <motion.div {...reveal} className="mx-auto mb-10 max-w-2xl text-center">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">One prompt, three tiers</h2>
          <p className="mt-3 text-ink-400">Complexity decides how far it cascades. Trivial asks get a direct answer; hard ones fan out across all three.</p>
        </motion.div>
        <div className="grid gap-4 md:grid-cols-3">
          {TIERS.map((t, i) => (
            <motion.div key={t.n} {...reveal} transition={{ ...reveal.transition, delay: i * 0.08 }}
              className="glass rounded-2xl p-6">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl text-sm font-bold text-white" style={{ background: t.color }}>{t.n}</span>
                <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: t.color }}>Tier {t.n}</div>
              </div>
              <h3 className="mt-4 text-lg font-semibold text-ink-50">{t.name}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-300">{t.text}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-6xl px-5 py-8 pb-16">
        <motion.h2 {...reveal} className="mb-10 text-center text-2xl font-bold tracking-tight sm:text-3xl">Everything you need to ship</motion.h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <motion.div key={f.title} {...reveal} transition={{ ...reveal.transition, delay: (i % 3) * 0.06 }}
              className="glass rounded-2xl p-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-500/12 text-accent-300">
                <f.icon size={19} />
              </div>
              <h3 className="mt-4 font-semibold text-ink-50">{f.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-400">{f.body}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section className="mx-auto max-w-3xl px-5 pb-20">
        <motion.div {...reveal} className="glass-strong relative overflow-hidden rounded-3xl px-6 py-12 text-center">
          <div className="pointer-events-none absolute inset-x-0 -top-16 mx-auto h-40 max-w-md rounded-full opacity-20 blur-3xl"
            style={{ background: 'radial-gradient(closest-side, #4C8DFF, transparent)' }} />
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
