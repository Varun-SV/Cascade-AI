import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import Modal from './Modal.js';
import { deleteAllConversations } from '../lib/api.js';
import { toast } from '../lib/toast.js';
import { detectLocalModelCapability } from '../lib/localModel/capability.js';
import {
  localModelEnabled, setLocalModelEnabled, reduceMotionEnabled, setReduceMotionEnabled,
  fastAnswerModel, setFastAnswerModel, tierParams, setTierParams, MAX_TIER_MAX_TOKENS,
  extendedContext, setExtendedContext, shareLearning, setShareLearning,
  rememberSessions, setRememberSessions,
  maxTokensPerRun, setMaxTokensPerRun, maxCostPerRunUsd, setMaxCostPerRunUsd,
  defaultRoutingBias, setDefaultRoutingBias,
  defaultWebSearch, setDefaultWebSearch,
  type ThemeMode, type Density, type TierParams, type TierParam, type ExtendedContextPref, type RoutingBias,
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
        type="number" min={1} max={MAX_TIER_MAX_TOKENS} step={64} inputMode="numeric"
        aria-label={`${tier.label} max tokens`}
        value={value.maxTokens ?? ''}
        onChange={(e) => onChange({ ...value, maxTokens: numOr(e.target.value) })}
        placeholder={`max tokens (≤${MAX_TIER_MAX_TOKENS.toLocaleString()})`}
        title={`Server limit: ${MAX_TIER_MAX_TOKENS.toLocaleString()} tokens per tier`}
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

/** The prototype's segmented control: a sunken well, the chosen option raised. */
function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; label: string;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex shrink-0 gap-0.5 rounded-[10px] bg-sunk p-[3px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-[7px] px-[11px] py-1 text-[13px] font-medium ${
            value === o.value ? 'bg-card text-ink-50 shadow-[0_1px_2px_rgba(0,0,0,0.1)]' : 'text-ink-300 hover:text-ink-50'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      data-on={on}
      className="cz-switch disabled:opacity-40"
    />
  );
}

function Row({ title, subtitle, right }: { title: React.ReactNode; subtitle?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3.5 border-b border-elev/10 py-[11px] last:border-0 max-[520px]:flex-wrap">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] text-ink-50">{title}</div>
        {subtitle && <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-500">{subtitle}</span>}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}

const fieldCls = 'cz-field h-[34px] w-28 text-[14px]';

interface Props {
  user: CloudUser;
  onClose: () => void;
  onOpenSkills: () => void;
  onOpenMemory: () => void;
  onOpenConnectors: () => void;
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
  runDetail: boolean;
  onRunDetailChange: (v: boolean) => void;
  /** Every chat was deleted: the parent clears its list and the open chat. */
  onChatsCleared: () => void;
}

export default function SettingsModal({
  user, onClose, onOpenSkills, onOpenMemory, onOpenConnectors, onOpenKeyVault, onOpenUpgrade, onLogout,
  onLocalModelChange, onReduceMotionChange,
  theme, onThemeChange, density, onDensityChange, runDetail, onRunDetailChange, onChatsCleared,
}: Props) {
  const cap = detectLocalModelCapability();
  const [localOn, setLocalOn] = useState(localModelEnabled());
  const [reduceMotion, setReduceMotion] = useState(reduceMotionEnabled());
  const [fastModel, setFastModel] = useState(fastAnswerModel());
  const [params, setParams] = useState<TierParams>(() => tierParams());
  const [extCtx, setExtCtx] = useState<ExtendedContextPref>(() => extendedContext());
  const [share, setShare] = useState<boolean>(() => shareLearning());
  const [remember, setRemember] = useState<boolean>(() => rememberSessions());
  const [maxRunTokens, setMaxRunTokens] = useState<number>(() => maxTokensPerRun());
  const [maxRunCost, setMaxRunCost] = useState<number>(() => maxCostPerRunUsd());
  const [routingBias, setRoutingBias] = useState<RoutingBias>(() => defaultRoutingBias());
  const [webDefault, setWebDefault] = useState<boolean>(() => defaultWebSearch());
  const isPro = user.plan === 'pro';

  type Tab = 'general' | 'appearance' | 'chat' | 'advanced' | 'privacy';
  const [tab, setTab] = useState<Tab>('general');
  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'general', label: 'General' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'chat', label: 'Chat' },
    { id: 'advanced', label: 'Advanced' },
    { id: 'privacy', label: 'Privacy' },
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

  async function clearAll() {
    if (!window.confirm("Delete all your chats? This can't be undone.")) return;
    try {
      await deleteAllConversations();
      onChatsCleared();
      toast('All chats deleted');
    } catch {
      toast('Could not delete all chats.');
    }
  }

  const manage = (label: string, open: () => void) => (
    <button type="button" aria-label={`Manage ${label}`} onClick={() => { onClose(); open(); }} className="cz-btn cz-btn-ghost cz-btn-sm">Manage</button>
  );
  const plan = user.plan ? user.plan.charAt(0).toUpperCase() + user.plan.slice(1) : 'Free';
  const via = user.provider ? user.provider.charAt(0).toUpperCase() + user.provider.slice(1) : null;

  return (
    <Modal title="Settings" onClose={onClose} maxWidth="max-w-[720px]">
      <div className="grid min-h-[340px] gap-[18px] px-5 pb-5 pt-1.5 sm:grid-cols-[150px_1fr]">
        <nav role="tablist" aria-label="Settings sections" aria-orientation="vertical" className="flex gap-0.5 overflow-x-auto sm:flex-col">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`settings-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="settings-panel"
              onClick={() => setTab(t.id)}
              className={`shrink-0 rounded-lg px-2.5 py-[7px] text-left text-[14px] ${
                tab === t.id ? 'bg-sunk text-ink-50' : 'text-ink-300 hover:text-ink-50'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`} className="min-w-0">
        {tab === 'general' && (
          <>
            <Row
              title={user.name ?? user.email ?? 'Signed in'}
              subtitle={`${via ? `Signed in with ${via} · ` : ''}${plan}${user.email && user.name ? ` · ${user.email}` : ''}`}
              right={<button type="button" onClick={() => { onClose(); onLogout(); }} className="cz-btn cz-btn-ghost cz-btn-sm">Sign out</button>}
            />
            <Row
              title="On-device assist"
              subtitle={
                cap.supported
                  ? 'Runs a small model in your browser (WebGPU) to name untitled chats and pre-classify routing complexity — so the server can skip a step and use fewer tokens. Downloads once (~a few hundred MB), then works offline; nothing leaves your device.'
                  : `Unavailable on this device — ${cap.reason}.`
              }
              right={<Toggle on={localOn && cap.supported} onChange={toggleLocal} disabled={!cap.supported} label="On-device assist" />}
            />
            <Row title="Skills" subtitle="Reusable personas for a chat" right={manage('Skills', onOpenSkills)} />
            <Row title="Memory" subtitle="Facts Cascade keeps across chats" right={manage('Memory', onOpenMemory)} />
            <Row title="Connectors & MCP" subtitle="Apps and MCP servers Cascade can use" right={manage('Connectors', onOpenConnectors)} />
            <Row title="API keys" subtitle="Your provider keys, encrypted on this device" right={manage('API keys', onOpenKeyVault)} />
            <Row
              title="Plan"
              subtitle={plan}
              right={<button type="button" onClick={() => { onClose(); onOpenUpgrade(); }} className="cz-btn cz-btn-ghost cz-btn-sm">Upgrade</button>}
            />
          </>
        )}

        {tab === 'appearance' && (
          <>
            <Row
              title="Theme"
              subtitle="Light, dark, or follow your system."
              right={
                <Segmented
                  label="Theme"
                  value={theme}
                  onChange={onThemeChange}
                  options={[
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                    { value: 'system', label: 'System' },
                  ]}
                />
              }
            />
            <Row
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
              title="Run detail"
              subtitle="Show the plan and agent tree while a run works."
              right={<Toggle on={runDetail} onChange={onRunDetailChange} label="Run detail" />}
            />
            <Row
              title="Reduce motion"
              subtitle="Minimize animations and transitions."
              right={<Toggle on={reduceMotion} onChange={toggleMotion} label="Reduce motion" />}
            />
          </>
        )}

        {tab === 'chat' && (
          <>
            <Row
              title="Default routing"
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
              title="Web search by default"
              subtitle="Start new chats with web search & fetch enabled. Off keeps chat as pure conversation until you toggle it on."
              right={<Toggle on={webDefault} onChange={(v) => { setWebDefault(v); setDefaultWebSearch(v); }} label="Web search by default" />}
            />
            <Row
              title="Fast answer model"
              subtitle={
                <>
                  The model Fast answer uses. Leave blank to auto-pick a capable mid-tier model.
                  <input
                    value={fastModel}
                    onChange={(e) => { setFastModel(e.target.value); setFastAnswerModel(e.target.value); }}
                    placeholder="auto — e.g. gpt-4o-mini"
                    spellCheck={false}
                    aria-label="Fast answer model"
                    className="cz-field mt-2 h-[34px] text-[14px]"
                  />
                </>
              }
            />
          </>
        )}

        {tab === 'advanced' && (
          <>
            <p className="m-0 flex items-center gap-1.5 pt-2 text-[11.5px] font-medium tracking-[0.02em] text-ink-500">
              <SlidersHorizontal size={12} /> Model parameters
            </p>
            <p className="mb-1 mt-1 text-[12.5px] text-ink-500">
              Per-tier limit on a <strong>single model call</strong> (its output ceiling) and sampling
              temperature. Blank = the model's default. This is not a whole-run budget — for that,
              see "Max tokens per run" and "Per-run cost cap" below.
            </p>
            <div className="rounded-[10px] bg-sunk/60 px-3 py-2">
              <div className="flex items-center gap-2 pb-1 text-[11px] font-medium text-ink-500">
                <span className="w-16">Tier</span>
                <span className="w-24">Max tokens/call</span>
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
              <Row
                title={<span className="text-[13px] text-ink-300">Max size past the window (before truncating)</span>}
                right={
                  <Segmented
                    label="Extended context cap"
                    value={String(extCtx.maxMultiplier)}
                    onChange={(v) => updateExtCtx({ ...extCtx, maxMultiplier: v === '3' ? 3 : 2 })}
                    options={[
                      { value: '2', label: '2×' },
                      { value: '3', label: '3×' },
                    ]}
                  />
                }
              />
            )}

            <Row
              title="Max tokens per run"
              subtitle="Ceiling on total tokens a single run may spend across all tiers. At 80% it starts no new work and writes the answer from what is done; it never goes past it. Blank = the default (200k). The per-run cost cap still applies."
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
                  className={fieldCls}
                />
              }
            />

            <Row
              title="Per-run cost cap (USD)"
              subtitle="A single run plans within this: fewer sections and cheaper models when it is small. At 80% it starts no new work and writes the answer from what is done, so you still get one; it never goes past the cap. You pay providers directly with your own keys. Blank = the default ($0.50). Range $0.05–$25."
              right={
                <input
                  type="number" min={0.05} max={25} step={0.05} inputMode="decimal"
                  aria-label="Per-run cost cap in USD"
                  value={maxRunCost || ''}
                  onChange={(e) => {
                    const v = e.target.value.trim() === '' ? 0 : Math.max(0, Number(e.target.value));
                    setMaxRunCost(v);
                    setMaxCostPerRunUsd(v);
                  }}
                  placeholder="0.50"
                  className={fieldCls}
                />
              }
            />
          </>
        )}

        {tab === 'privacy' && (
          <>
            <Row
              title="Remember chats in Memory"
              subtitle="Opt-in: after a chat, Cascade distills durable facts (your preferences, project details) into Memory so future chats remember them. Off by default — you manage and delete these in the Memory panel."
              right={
                <Toggle
                  on={remember}
                  onChange={(v) => { setRemember(v); setRememberSessions(v); }}
                  label="Remember chats in Memory"
                />
              }
            />
            <Row
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
                  <span className="rounded-full bg-sunk px-2 py-px text-[11px] text-ink-300">Always on</span>
                )
              }
            />
            <Row
              title="Delete all chats"
              subtitle="Removes every chat and its messages. This can't be undone."
              right={<button type="button" onClick={() => void clearAll()} className="cz-btn cz-btn-danger cz-btn-sm">Delete</button>}
            />
          </>
        )}
        </div>
      </div>
    </Modal>
  );
}
