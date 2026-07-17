import { useState } from 'react';
import {
  Sparkles, Brain, KeyRound, Crown, LogOut, Cpu, Eye, ChevronRight, Zap,
  Sun, Moon, Monitor, LayoutGrid, Rows3, SlidersHorizontal, Layers, LineChart,
  User, Palette, MessageSquare, Shield, Globe, Gauge,
} from 'lucide-react';
import Modal from './Modal.js';
import { detectLocalModelCapability } from '../lib/localModel/capability.js';
import {
  localModelEnabled, setLocalModelEnabled, reduceMotionEnabled, setReduceMotionEnabled,
  fastAnswerModel, setFastAnswerModel, tierParams, setTierParams,
  extendedContext, setExtendedContext, shareLearning, setShareLearning,
  maxTokensPerRun, setMaxTokensPerRun, defaultRoutingBias, setDefaultRoutingBias,
  defaultWebSearch, setDefaultWebSearch,
  type ThemeMode, type Density, type UiMode, type TierParams, type TierParam, type ExtendedContextPref, type RoutingBias,
} from '../lib/prefs.js';
import type { CloudUser } from '../lib/types.js';

const TIERS: Array<{ key: 't1' | 't2' | 't3'; label: string; role: string; dot: string }> = [
  { key: 't1', label: 'T1', role: 'Planner', dot: 'bg-t1' },
  { key: 't2', label: 'T2', role: 'Manager', dot: 'bg-t2' },
  { key: 't3', label: 'T3', role: 'Worker', dot: 'bg-t3' },
];

/** One tier's max-tokens + temperature inputs. Blank = SDK default. */
function TierParamRow({ tier, value, onChange }: {
  tier: { key: 't1' | 't2' | 't3'; label: string; role: string; dot: string };
  value: TierParam; onChange: (v: TierParam) => void;
}) {
  const numOr = (s: string): number | undefined => (s.trim() === '' ? undefined : Number(s));
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className="flex w-16 shrink-0 items-center gap-1.5 text-xs text-ink-200">
        <span className={`h-2 w-2 rounded-full ${tier.dot}`} />
        <span className="font-semibold">{tier.label}</span>
      </span>
      <input
        type="number" min={1} step={64} inputMode="numeric"
        aria-label={`${tier.label} max tokens`}
        value={value.maxTokens ?? ''}
        onChange={(e) => onChange({ ...value, maxTokens: numOr(e.target.value) })}
        placeholder="max tokens"
        className="w-24 rounded-md border border-elev/10 bg-elev/[0.04] px-2 py-1 text-xs text-ink-100 outline-none placeholder:text-ink-500 focus:border-accent-500/40"
      />
      <input
        type="number" min={0} max={2} step={0.1} inputMode="decimal"
        aria-label={`${tier.label} temperature`}
        value={value.temperature ?? ''}
        onChange={(e) => onChange({ ...value, temperature: numOr(e.target.value) })}
        placeholder="temp 0–2"
        className="w-24 rounded-md border border-elev/10 bg-elev/[0.04] px-2 py-1 text-xs text-ink-100 outline-none placeholder:text-ink-500 focus:border-accent-500/40"
      />
    </div>
  );
}

/** Compact segmented control — one active option, keyboard/aria friendly. */
function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; label: string;
  options: Array<{ value: T; label: string; icon?: React.ReactNode }>;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-0.5 rounded-lg bg-elev/[0.05] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            value === o.value
              ? 'bg-accent-500 text-white shadow-sm'
              : 'text-ink-400 hover:bg-elev/10 hover:text-ink-100'
          }`}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  // Flex + justify keeps the knob physically inside the track — it can't
  // overflow the way an absolute/translate knob could when the pixel math is
  // off. items-center handles the vertical centering.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition-colors disabled:opacity-40 ${
        on ? 'justify-end bg-accent-500' : 'justify-start bg-elev/15'
      }`}
    >
      <span className="h-4 w-4 rounded-full bg-white shadow-sm" />
    </button>
  );
}

function Row({ icon, title, subtitle, right }: { icon: React.ReactNode; title: string; subtitle?: string; right: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 text-ink-400">{icon}</span>
        <div className="min-w-0">
          <p className="text-sm text-ink-100">{title}</p>
          {subtitle && <p className="mt-0.5 text-xs text-ink-400">{subtitle}</p>}
        </div>
      </div>
      <div className="shrink-0">{right}</div>
    </div>
  );
}

interface Props {
  user: CloudUser;
  onClose: () => void;
  onOpenSkills: () => void;
  onOpenMemory: () => void;
  onOpenKeyVault: () => void;
  onOpenUpgrade: () => void;
  onLogout: () => void;
  /** Reflects the current pref so App can react (e.g. toggle motion live). */
  onLocalModelChange: (v: boolean) => void;
  onReduceMotionChange: (v: boolean) => void;
  theme: ThemeMode;
  onThemeChange: (v: ThemeMode) => void;
  density: Density;
  onDensityChange: (v: Density) => void;
  uiMode: UiMode;
  onUiModeChange: (v: UiMode) => void;
}

function LinkRow({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-sm text-ink-200 hover:bg-elev/[0.06]"
    >
      <span className="flex items-center gap-2.5">{icon} {label}</span>
      <ChevronRight size={15} className="text-ink-500" />
    </button>
  );
}

export default function SettingsModal({
  user, onClose, onOpenSkills, onOpenMemory, onOpenKeyVault, onOpenUpgrade, onLogout,
  onLocalModelChange, onReduceMotionChange,
  theme, onThemeChange, density, onDensityChange, uiMode, onUiModeChange,
}: Props) {
  const cap = detectLocalModelCapability();
  const [localOn, setLocalOn] = useState(localModelEnabled());
  const [reduceMotion, setReduceMotion] = useState(reduceMotionEnabled());
  const [fastModel, setFastModel] = useState(fastAnswerModel());
  const [params, setParams] = useState<TierParams>(() => tierParams());
  const [extCtx, setExtCtx] = useState<ExtendedContextPref>(() => extendedContext());
  const [share, setShare] = useState<boolean>(() => shareLearning());
  const [maxRunTokens, setMaxRunTokens] = useState<number>(() => maxTokensPerRun());
  const [routingBias, setRoutingBias] = useState<RoutingBias>(() => defaultRoutingBias());
  const [webDefault, setWebDefault] = useState<boolean>(() => defaultWebSearch());
  const isPro = user.plan === 'pro';

  // Tabbed layout so the (now long) settings never force an awkward scroll —
  // each pane is short. The active pane still scrolls internally if needed.
  type Tab = 'general' | 'appearance' | 'chat' | 'advanced' | 'privacy';
  const [tab, setTab] = useState<Tab>('general');
  const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: 'general', label: 'General', icon: <User size={14} /> },
    { id: 'appearance', label: 'Appearance', icon: <Palette size={14} /> },
    { id: 'chat', label: 'Chat', icon: <MessageSquare size={14} /> },
    { id: 'advanced', label: 'Advanced', icon: <SlidersHorizontal size={14} /> },
    { id: 'privacy', label: 'Privacy', icon: <Shield size={14} /> },
  ];

  function updateTierParam(key: 't1' | 't2' | 't3', v: TierParam) {
    const next = { ...params, [key]: v };
    setParams(next);
    setTierParams(next);
  }
  function updateExtCtx(v: ExtendedContextPref) {
    setExtCtx(v);
    setExtendedContext(v);
  }

  function toggleLocal(v: boolean) {
    setLocalOn(v);
    setLocalModelEnabled(v);
    onLocalModelChange(v);
  }
  function toggleMotion(v: boolean) {
    setReduceMotion(v);
    setReduceMotionEnabled(v);
    onReduceMotionChange(v);
  }

  return (
    <Modal title="Settings" onClose={onClose} maxWidth="max-w-lg">
      {/* Tab bar — horizontally scrollable so it never breaks the layout at
          narrow widths; the active pane below carries the content. */}
      <div className="flex gap-1 overflow-x-auto border-b border-elev/10 px-3 pt-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`flex shrink-0 items-center gap-1.5 rounded-t-lg px-3 py-2 text-xs font-medium transition-colors ${
              tab === t.id
                ? 'border-b-2 border-accent-500 text-ink-100'
                : 'border-b-2 border-transparent text-ink-400 hover:text-ink-100'
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      <div className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto p-4 text-sm text-ink-100">
        {tab === 'general' && (
          <>
            {/* Account */}
            <div className="mb-1 rounded-lg bg-elev/[0.04] px-3 py-2.5">
              <p className="font-medium text-ink-100">{user.name ?? 'Signed in'}</p>
              {user.email && <p className="text-xs text-ink-400">{user.email}</p>}
              <div className="mt-1.5 flex items-center gap-2">
                <span className="rounded bg-elev/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-300">
                  {user.plan} plan
                </span>
                <span className="text-[10px] text-ink-500">via {user.provider}</span>
              </div>
            </div>

            <Row
              icon={<Cpu size={15} />}
              title="On-device assist"
              subtitle={
                cap.supported
                  ? 'Runs a small model in your browser (WebGPU) to name untitled chats and pre-classify routing complexity — so the server can skip a step and use fewer tokens. Downloads once (~a few hundred MB), then works offline; nothing leaves your device.'
                  : `Unavailable on this device — ${cap.reason}.`
              }
              right={<Toggle on={localOn && cap.supported} onChange={toggleLocal} disabled={!cap.supported} label="On-device assist" />}
            />

            <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Manage</p>
            <LinkRow icon={<Sparkles size={15} className="text-ink-400" />} label="Skills" onClick={() => { onClose(); onOpenSkills(); }} />
            <LinkRow icon={<Brain size={15} className="text-ink-400" />} label="Memory" onClick={() => { onClose(); onOpenMemory(); }} />
            <LinkRow icon={<KeyRound size={15} className="text-ink-400" />} label="API keys" onClick={() => { onClose(); onOpenKeyVault(); }} />
            <LinkRow icon={<Crown size={15} className="text-ink-400" />} label="Upgrade" onClick={() => { onClose(); onOpenUpgrade(); }} />

            <button
              type="button"
              onClick={() => { onClose(); onLogout(); }}
              className="mt-2 flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-danger-300 hover:bg-danger-500/10"
            >
              <LogOut size={15} /> Sign out
            </button>
          </>
        )}

        {tab === 'appearance' && (
          <>
            <Row
              icon={<Sun size={15} />}
              title="Theme"
              subtitle="Light, dark, or follow your system."
              right={
                <Segmented
                  label="Theme"
                  value={theme}
                  onChange={onThemeChange}
                  options={[
                    { value: 'light', label: 'Light', icon: <Sun size={13} /> },
                    { value: 'dark', label: 'Dark', icon: <Moon size={13} /> },
                    { value: 'system', label: 'System', icon: <Monitor size={13} /> },
                  ]}
                />
              }
            />
            <Row
              icon={<Rows3 size={15} />}
              title="Density"
              subtitle="Comfortable spacing or a tighter, compact layout."
              right={
                <Segmented
                  label="Density"
                  value={density}
                  onChange={onDensityChange}
                  options={[
                    { value: 'comfortable', label: 'Cozy' },
                    { value: 'compact', label: 'Compact' },
                  ]}
                />
              }
            />
            <Row
              icon={<LayoutGrid size={15} />}
              title="View"
              subtitle="Simple keeps chat minimal; Advanced reveals routing controls and tier detail."
              right={
                <Segmented
                  label="View mode"
                  value={uiMode}
                  onChange={onUiModeChange}
                  options={[
                    { value: 'simple', label: 'Simple' },
                    { value: 'advanced', label: 'Advanced' },
                  ]}
                />
              }
            />
            <Row
              icon={<Eye size={15} />}
              title="Reduce motion"
              subtitle="Minimize animations and transitions."
              right={<Toggle on={reduceMotion} onChange={toggleMotion} label="Reduce motion" />}
            />
          </>
        )}

        {tab === 'chat' && (
          <>
            <Row
              icon={<Sparkles size={15} />}
              title="Default response bias"
              subtitle="How new chats start: Auto balances cost & quality, Quality favors stronger models, Fast favors cheaper/quicker ones. Change it per chat anytime."
              right={
                <Segmented
                  label="Default response bias"
                  value={routingBias}
                  onChange={(v) => { setRoutingBias(v); setDefaultRoutingBias(v); }}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'quality', label: 'Quality' },
                    { value: 'fast', label: 'Fast' },
                  ]}
                />
              }
            />
            <Row
              icon={<Globe size={15} />}
              title="Web search by default"
              subtitle="Start new chats with web search & fetch enabled. Off keeps chat as pure conversation until you toggle it on."
              right={<Toggle on={webDefault} onChange={(v) => { setWebDefault(v); setDefaultWebSearch(v); }} label="Web search by default" />}
            />
            <div className="flex items-start gap-2.5 py-2.5">
              <span className="mt-0.5 text-ink-400"><Zap size={15} /></span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink-100">Fast answer model</p>
                <p className="mt-0.5 text-xs text-ink-400">The model the ⚡ Fast answer button uses. Leave blank to auto-pick a capable mid-tier model.</p>
                <input
                  value={fastModel}
                  onChange={(e) => { setFastModel(e.target.value); setFastAnswerModel(e.target.value); }}
                  placeholder="auto — e.g. gpt-4o-mini"
                  spellCheck={false}
                  className="mt-1.5 w-full rounded-md border border-elev/10 bg-elev/[0.04] px-2.5 py-1.5 text-sm text-ink-100 outline-none placeholder:text-ink-500 focus:border-accent-500/40"
                />
              </div>
            </div>
          </>
        )}

        {tab === 'advanced' && (
          <>
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
              <SlidersHorizontal size={12} /> Model parameters
            </p>
            <p className="mb-1 text-xs text-ink-400">
              Per-tier output limit and sampling temperature. Blank = the model's default.
              Applied to that tier's calls across the orchestration.
            </p>
            <div className="rounded-lg border border-elev/10 bg-elev/[0.03] px-3 py-2">
              <div className="flex items-center gap-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-500">
                <span className="w-16">Tier</span>
                <span className="w-24">Max tokens</span>
                <span className="w-24">Temperature</span>
              </div>
              {TIERS.map((t) => (
                <TierParamRow
                  key={t.key}
                  tier={t}
                  value={params[t.key] ?? {}}
                  onChange={(v) => updateTierParam(t.key, v)}
                />
              ))}
            </div>

            <Row
              icon={<Layers size={15} />}
              title="Extended context"
              subtitle="Compact history and oversized inputs so they fit the model's window — a big paste is chunked, summarized, and combined (with a one-tap confirm before the extra calls)."
              right={
                <Toggle
                  on={extCtx.enabled}
                  onChange={(on) => updateExtCtx({ ...extCtx, enabled: on })}
                  label="Extended context"
                />
              }
            />
            {extCtx.enabled && (
              <div className="flex items-center justify-between gap-3 pb-1 pl-7">
                <span className="text-xs text-ink-400">Max size past the window (before truncating)</span>
                <Segmented
                  label="Extended context cap"
                  value={String(extCtx.maxMultiplier)}
                  onChange={(v) => updateExtCtx({ ...extCtx, maxMultiplier: v === '3' ? 3 : 2 })}
                  options={[
                    { value: '2', label: '2×' },
                    { value: '3', label: '3×' },
                  ]}
                />
              </div>
            )}

            <Row
              icon={<Gauge size={15} />}
              title="Max tokens per run"
              subtitle="Hard ceiling on total tokens a single run may spend across all tiers — a runaway multi-agent run stops here. Blank = the default (200k). The per-run cost limit still applies."
              right={
                <input
                  type="number" min={1000} step={1000} inputMode="numeric"
                  aria-label="Max tokens per run"
                  value={maxRunTokens || ''}
                  onChange={(e) => {
                    const v = e.target.value.trim() === '' ? 0 : Math.max(0, Number(e.target.value));
                    setMaxRunTokens(v);
                    setMaxTokensPerRun(v);
                  }}
                  placeholder="200000"
                  className="w-28 shrink-0 rounded-md border border-elev/10 bg-elev/[0.04] px-2.5 py-1.5 text-sm text-ink-100 outline-none placeholder:text-ink-500 focus:border-accent-500/40"
                />
              }
            />
          </>
        )}

        {tab === 'privacy' && (
          <Row
            icon={<LineChart size={15} />}
            title="Improve routing for everyone"
            subtitle={
              isPro
                ? 'Contribute anonymous outcome stats (model, task type, success/failure, size) so Cascade routes smarter over time. No prompts or content are ever stored.'
                : 'Anonymous outcome stats (model, task type, success/failure, size) help Cascade route smarter over time. No prompts or content are stored. Included on the free plan; upgrade to Pro to opt out.'
            }
            right={
              isPro ? (
                <Toggle
                  on={share}
                  onChange={(v) => { setShare(v); setShareLearning(v); }}
                  label="Share anonymous performance data"
                />
              ) : (
                <span className="shrink-0 rounded bg-elev/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                  Always on
                </span>
              )
            }
          />
        )}
      </div>
    </Modal>
  );
}
