import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, useReducedMotion } from 'framer-motion';
import { Github, Check, Sparkles } from 'lucide-react';
import type { CloudConfig } from '../lib/api.js';
import { devLogin } from '../lib/api.js';
import { savePendingPrompt } from '../lib/pendingPrompt.js';
import CascadeMark from './CascadeMark.js';
import DownloadSection from './DownloadSection.js';
import Modal from './Modal.js';
import type { DescentPlan, DescentScene } from './landing/descentScene.js';
import './landing/descent.css';

interface Props {
  /**
   * Settings → Reduce motion. App renders the landing outside its
   * MotionConfig, so the saved preference has to be handed in; the OS
   * preference alone would leave a visitor who turned motion off in Cascade
   * watching a camera flight the moment they sign out.
   */
  reduceMotion?: boolean;
  config: CloudConfig;
  onDevLogin: () => void;
}

const REPO = 'https://github.com/Varun-SV/Cascade-AI';
const NPM = 'npm i -g cascade-ai';

/**
 * Example prompts a visitor can pour in, each with the plan its labels show on
 * the way down. These illustrate how a run looks; they are not recorded runs.
 */
const EXAMPLES: Array<{ prompt: string; plan: DescentPlan }> = [
  {
    prompt: 'Research three competitors, export a Word report',
    plan: { sections: ['Research', 'Compare', 'Write the report'], tools: ['search', 'browse', 'read', 'table', 'write', 'format', 'docx'], file: 'competitor-report.docx' },
  },
  {
    prompt: 'Refactor auth to JWT, add tests, open a PR',
    plan: { sections: ['Token service', 'Middleware', 'Tests and PR'], tools: ['read', 'code', 'code', 'edit', 'test', 'test', 'git'], file: 'pull request' },
  },
  {
    prompt: 'Plan a two-week trip with a budget sheet',
    plan: { sections: ['Route', 'Bookings', 'Budget sheet'], tools: ['search', 'map', 'search', 'compare', 'browse', 'sheet', 'sheet'], file: 'trip-budget.xlsx' },
  },
];
const GENERIC_PLAN: DescentPlan = { sections: ['Understand', 'Do the work', 'Assemble'], tools: ['search', 'browse', 'read', 'write', 'code', 'check', 'write'], file: 'result.md' };

/** When each chapter's text is on screen, as a share of the descent. */
const CHAPTERS: Array<[number, number]> = [[0.06, 0.21], [0.24, 0.41], [0.44, 0.59], [0.6, 0.75], [0.79, 0.9]];
const JUMPS = [0, 0.08, 0.26, 0.46, 0.62, 0.995];
const seg = (p: number, a: number, b: number) => Math.max(0, Math.min(1, (p - a) / (b - a)));

const ARC_D = ['M3.5 7.5 Q12 14.5 20.5 7.5', 'M6.25 12.5 Q12 17.75 17.75 12.5', 'M9 17.5 Q12 20.5 15 17.5'];
const TIER_HEX = ['#6FA3FF', '#4CC3EC', '#3EDFC9'];

export default function LandingPage({ config, onDevLogin, reduceMotion = false }: Props) {
  const [devName, setDevName] = useState('');
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [copied, setCopied] = useState(false);
  const [prompt, setPromptText] = useState('');
  const [echo, setEcho] = useState(EXAMPLES[0].prompt);
  const canSignIn = config.githubEnabled || config.googleEnabled;
  const reduced = (useReducedMotion() ?? false) || reduceMotion;

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const afterRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const revealRef = useRef<HTMLElement>(null);
  const storyRef = useRef<HTMLHeadingElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const chapterRefs = useRef<Array<HTMLDivElement | null>>([]);
  const sceneRef = useRef<DescentScene | null>(null);
  // The prompt the scene should show. Kept outside the scene because the scene
  // loads lazily: a visitor on a slow connection can pour a prompt in before it
  // exists, and initialising it with the first example would then contradict
  // the prompt they chose.
  const chosenRef = useRef<{ prompt: string; plan: DescentPlan }>({ prompt: EXAMPLES[0].prompt, plan: EXAMPLES[0].plan });
  // Still when motion is reduced, or when WebGL is unavailable. Derived, not
  // seeded once, so turning reduce-motion on or off takes effect immediately.
  const [noWebgl, setNoWebgl] = useState(false);
  const still = reduced || noWebgl;

  // The page's own chapter text follows the scene's smoothed progress, written
  // straight to the DOM each frame so React never re-renders at 60 fps.
  function paint(p: number) {
    const hero = heroRef.current;
    if (hero) {
      hero.style.opacity = String(1 - seg(p, 0.012, 0.05));
      hero.style.pointerEvents = p < 0.03 ? 'auto' : 'none';
      // Faded is not gone: without inert, Tab still lands on the prompt
      // input and example chips after they have scrolled out of sight.
      hero.inert = p >= 0.03;
      hero.hidden = p > 0.06;
    }
    chapterRefs.current.forEach((c, i) => c?.classList.toggle('on', p >= CHAPTERS[i][0] && p <= CHAPTERS[i][1]));
    const past = (afterRef.current?.getBoundingClientRect().top ?? Infinity) < window.innerHeight * 0.9;
    const reveal = revealRef.current;
    if (reveal && !rootRef.current?.classList.contains('still')) {
      const on = p > 0.94 && !past;
      reveal.classList.toggle('on', on);
      // Invisible is not enough: opacity 0 leaves its buttons in the tab order,
      // so a keyboard user could focus and press controls they cannot see.
      reveal.inert = !on;
    }
    const rail = railRef.current;
    if (rail) {
      rail.style.opacity = past ? '0' : '1';
      rail.style.pointerEvents = past ? 'none' : '';
      rail.inert = past;
      const tiers = [seg(p, 0.05, 0.22), seg(p, 0.24, 0.45), seg(p, 0.45, 0.9)];
      rail.querySelectorAll<SVGPathElement>('.rp').forEach((el, i) => { el.style.strokeDashoffset = String(1 - tiers[i]); });
      const cur = p < 0.22 ? 0 : p < 0.45 ? 1 : p < 0.9 ? 2 : 3;
      rail.querySelectorAll('button').forEach((b, i) => { if (i === cur) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
    }
  }

  function progress(): number {
    const root = rootRef.current, track = trackRef.current;
    if (!root || !track) return 0;
    const len = track.offsetHeight - root.clientHeight;
    return len > 0 ? Math.max(0, Math.min(1, (root.scrollTop - track.offsetTop) / len)) : 0;
  }

  useEffect(() => {
    let disposed = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // three.js loads only here, so signed-in visitors never download it.
    import('./landing/descentScene.js').then(({ createDescentScene }) => {
      if (disposed) return;
      const scene = createDescentScene(canvas, { still: reduced, onFrame: paint });
      if (!scene) { setNoWebgl(true); return; }
      sceneRef.current = scene;
      scene.setPrompt(chosenRef.current.prompt, chosenRef.current.plan);
      if (reduced) { paint(1); return; }
      scene.setTarget(progress());
      onScroll();
    }).catch(() => {
      // The chunk can fail to download (a flaky network, or a deploy that
      // replaced it). Without this the story text never appears and the
      // visitor scrolls a blank track; the still layout tells it instead.
      if (!disposed) setNoWebgl(true);
    });
    const root = rootRef.current;
    const onScroll = () => {
      const scene = sceneRef.current;
      if (!scene) return;
      scene.setTarget(progress());
      // Once the page below covers the fixed canvas there is nothing to draw.
      const covered = (afterRef.current?.getBoundingClientRect().top ?? Infinity) <= 0;
      if (covered) paint(progress());
      scene.setActive(!covered);
    };
    root?.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      disposed = true;
      root?.removeEventListener('scroll', onScroll);
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  // The reveal starts out of the tab order until the descent reaches it; in the
  // still layout it is ordinary page content, always reachable.
  useLayoutEffect(() => {
    const reveal = revealRef.current;
    if (!reveal) return;
    reveal.inert = !still && !reveal.classList.contains('on');
    if (still) reveal.classList.remove('on');
  }, [still]);

  // "How it works": the descent's first chapter when it is animated; in the
  // still layout the track has no height and the chapters are hidden, so the
  // story lives as text below — go there, and put focus on it so a keyboard or
  // screen-reader user lands where they asked to go.
  function howItWorks() {
    const story = storyRef.current;
    if (!still || !story) { jump(1); return; }
    const root = rootRef.current;
    if (root) {
      // Relative to the scroll container, not the story's positioned parent.
      const top = root.scrollTop + story.getBoundingClientRect().top - root.getBoundingClientRect().top - 24;
      root.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    }
    story.focus({ preventScroll: true });
  }

  function jump(i: number) {
    const root = rootRef.current, track = trackRef.current;
    if (!root || !track) return;
    const len = track.offsetHeight - root.clientHeight;
    root.scrollTo({ top: track.offsetTop + JUMPS[i] * len, behavior: reduced ? 'auto' : 'smooth' });
  }

  function pour(text: string) {
    const typed = text.trim() || EXAMPLES[0].prompt;
    const match = EXAMPLES.find((e) => e.prompt === typed);
    chosenRef.current = { prompt: typed, plan: match?.plan ?? GENERIC_PLAN };
    // Kept for after sign-in, so "run this for real" means THIS prompt.
    savePendingPrompt(typed);
    sceneRef.current?.setPrompt(chosenRef.current.prompt, chosenRef.current.plan);
    setEcho(typed.length > 46 ? `${typed.slice(0, 45)}…` : typed);
    jump(1);
  }

  // What the prompt box holds when sign-in opens is what goes with it, poured
  // or not — and an emptied box carries nothing, so a cleared example does
  // not resurface in the chat. savePendingPrompt('') removes the entry.
  function openSignIn() {
    savePendingPrompt(prompt);
    setSigningIn(true);
  }

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
    { name: 'Free', features: ['20 runs a day', '1 run at a time', 'Web search and fetch', ...(config.remoteBrowserEnabled ? ['5 browser sessions a day'] : [])] },
    { name: 'Pro', features: ['200 runs a day', '3 runs at a time', 'Priority routing', ...(config.remoteBrowserEnabled ? ['50 browser sessions a day'] : [])] },
  ];
  const h2 = 'm-0 mb-7 max-w-[18ch] font-serif text-[clamp(30px,4vw,44px)] font-normal leading-[1.1] tracking-[-0.02em] text-ink-50';
  const story = [
    { tier: 'T1 · Plans', color: TIER_HEX[0], title: 'Your prompt lands with a planner.', body: 'A capable model reads it, sizes it and splits it into sections. You can review and edit that plan before anyone starts. Small jobs skip the hierarchy and go to one worker.' },
    { tier: 'T2 · Manages', color: TIER_HEX[1], title: 'Managers take a section each.', body: 'They brief their workers, check what comes back, and push back on anything unclear instead of guessing.' },
    { tier: 'T3 · Works', color: TIER_HEX[2], title: 'Workers fan out, in parallel.', body: 'They search, browse, write code and build documents. Small, fast models do this work, local ones included.' },
    { tier: 'Comms', color: '#F5F6F9', title: 'They talk while they work.', body: 'Messages, file locks and hand-offs between workers, on your screen. Risky actions climb the tiers to you for approval.' },
    { tier: 'Result', color: TIER_HEX[2], title: 'Everything rejoins into one answer.', body: 'In a real run it comes with a receipt for every step: which model did what, and why it was chosen.' },
  ];

  return (
    <div ref={rootRef} className={`descent${still ? ' still' : ''}`}>
      <canvas ref={canvasRef} className="dv-stage" aria-hidden="true" />

      <header className="dv-hdr">
        <span className="flex items-center gap-[9px]">
          <CascadeMark size={24} animate={false} />
          <b className="font-serif text-[20px] font-medium tracking-[-0.01em]">Cascade</b>
        </span>
        <nav aria-label="Primary">
          <a href="#how" onClick={(e) => { e.preventDefault(); howItWorks(); }}>How it works</a>
          <a href="/docs">Docs</a>
          <a href="#download">Download</a>
          <a href={REPO} target="_blank" rel="noopener noreferrer">GitHub</a>
        </nav>
        <span className="flex-1" />
        <button type="button" onClick={openSignIn} className="dv-btn dv-btn-g">Sign in</button>
        <button type="button" onClick={openSignIn} className="dv-btn dv-btn-p dv-try">Try Cascade</button>
      </header>

      <section ref={heroRef} className="dv-hero" aria-labelledby="dv-hero-h">
        <h1 id="dv-hero-h">One prompt.<br />A whole organization.</h1>
        <p>Hand Cascade anything you would give a team. Then scroll, and follow how it would run.</p>
        <form className="dv-ask" onSubmit={(e) => { e.preventDefault(); pour(prompt); }}>
          <label htmlFor="dv-ask-in" className="sr-only">Your prompt</label>
          <input id="dv-ask-in" aria-describedby="dv-sim-note" autoComplete="off" maxLength={90} placeholder="What should your organization do?" value={prompt} onChange={(e) => {
            setPromptText(e.target.value);
            // Clearing the box withdraws an earlier pour right away, not only
            // when sign-in opens: an abandoned dialog must not leave it behind.
            if (!e.target.value.trim()) savePendingPrompt('');
          }} />
          <button type="submit" className="dv-btn dv-btn-p">Pour it in</button>
        </form>
        <div className="dv-chips" role="group" aria-label="Example prompts">
          {EXAMPLES.map((ex) => (
            <button key={ex.prompt} type="button" className="dv-chip" onClick={() => { setPromptText(ex.prompt); pour(ex.prompt); }}>{ex.prompt}</button>
          ))}
        </div>
        {/* The descent is scripted: the plan comes from the examples, not from
            running the prompt, so it says so before anything is poured in. */}
        <p id="dv-sim-note" className="dv-note">A simulated walkthrough. Your prompt isn't sent anywhere; sign in to run it for real.</p>
        <span className="dv-hint">Scroll to descend</span>
      </section>

      {story.map((c, i) => (
        <div key={c.tier} ref={(el) => { chapterRefs.current[i] = el; }} className="dv-ch" role="region" aria-label={c.tier} id={i === 0 ? 'how' : undefined}>
          <p className="ey"><i style={{ background: c.color }} />{c.tier}</p>
          <h2>{c.title}</h2>
          <p>{c.body}</p>
          {i === 0 && <p className="echo">Walkthrough for “{echo}”</p>}
        </div>
      ))}

      <nav ref={railRef} className="dv-rail" aria-label="Descent progress">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          {ARC_D.map((d) => <path key={`b${d}`} d={d} stroke="rgba(233,235,240,.14)" strokeWidth="2.1" strokeLinecap="round" />)}
          {ARC_D.map((d, i) => <path key={`f${d}`} className="rp" d={d} pathLength={1} strokeDasharray="1" strokeDashoffset="1" stroke={TIER_HEX[i]} strokeWidth="2.1" strokeLinecap="round" />)}
        </svg>
        {['T1', 'T2', 'T3', 'END'].map((l, i) => (
          <button key={l} type="button" onClick={() => jump(i === 3 ? 5 : i + 1)}>{l}</button>
        ))}
      </nav>

      <section ref={revealRef} className="dv-reveal" aria-labelledby="dv-rev-h">
        <h2 id="dv-rev-h">That's how Cascade runs it.</h2>
        <p>A simulated walkthrough: one prompt becomes a plan, a few managers and a floor of workers, and comes back as one result. Sign in to run your own prompt for real, free to start with your own API keys.</p>
        <div className="dv-ctas">
          <button type="button" className="dv-btn dv-btn-p" onClick={openSignIn}>Sign in to run this for real</button>
          <a className="dv-btn dv-btn-g" href="#download">Download the desktop app</a>
          <button type="button" className="dv-npm" onClick={copyNpm} title="Copy">
            {NPM} {copied ? <Check size={14} className="text-success-500" /> : <span style={{ color: TIER_HEX[1] }}>Copy</span>}
            <span className="sr-only">{copied ? 'Copied' : 'Copy the install command'}</span>
          </button>
        </div>
      </section>

      <div ref={trackRef} className="dv-track" aria-hidden="true" />

      <div ref={afterRef} className="dv-after">
        <div className="mx-auto max-w-[1080px] px-6 pb-2">
          {still && (
            <section className="pt-[72px]">
              <h2 ref={storyRef} id="how-story" tabIndex={-1} className={`${h2} outline-none`}>How one prompt moves through Cascade.</h2>
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))]">
                {story.map((c) => (
                  <div key={c.tier} className="flex flex-col gap-1.5 rounded-2xl bg-card p-[18px]">
                    <b className="font-mono text-[12px] uppercase tracking-[0.12em] text-ink-300">{c.tier}</b>
                    <span className="text-ink-100">{c.title}</span>
                    <span className="text-[14px] text-ink-300">{c.body}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="pt-[88px]">
            <h2 className={h2}>Wherever you work.</h2>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
              {[
                ['CLI', NPM, true], ['Desktop', 'Chat, a live agent tree, an editor and a browser.', false], ['Cloud', 'Nothing to install. Bring your keys.', false],
                ['Self-host', 'docker compose up', true], ['API', 'OpenAI-compatible chat completions.', false], ['SDK', 'runCascade() from Node.', false],
              ].map(([name, body, mono]) => (
                <div key={name as string} className="flex min-w-0 flex-col gap-1.5 rounded-2xl bg-card p-5">
                  <b className="font-semibold text-ink-50">{name}</b>
                  <span className={mono ? 'font-mono text-[13px] text-ink-300' : 'text-[14.5px] text-ink-300'}>{body}</span>
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
