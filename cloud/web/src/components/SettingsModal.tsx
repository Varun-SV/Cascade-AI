import { useState } from 'react';
import {
  Sparkles, Brain, KeyRound, Crown, LogOut, Cpu, Eye, ChevronRight, Zap,
  Sun, Moon, Monitor, LayoutGrid, Rows3,
} from 'lucide-react';
import Modal from './Modal.js';
import { detectLocalModelCapability } from '../lib/localModel/capability.js';
import {
  localModelEnabled, setLocalModelEnabled, reduceMotionEnabled, setReduceMotionEnabled,
  fastAnswerModel, setFastAnswerModel,
  type ThemeMode, type Density, type UiMode,
} from '../lib/prefs.js';
import type { CloudUser } from '../lib/types.js';

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
    <Modal title="Settings" onClose={onClose} maxWidth="max-w-md">
      <div className="flex flex-col gap-1 p-4 text-sm text-ink-100">
        {/* Account */}
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Account</p>
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

        {/* On-device model */}
        <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-400">On-device</p>
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

        {/* Appearance */}
        <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Appearance</p>
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
                { value: 'system', label: 'Auto', icon: <Monitor size={13} /> },
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

        {/* Chat */}
        <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Chat</p>
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

        {/* Manage */}
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
      </div>
    </Modal>
  );
}
