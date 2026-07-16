import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Copy, Check, ArrowRight, Loader2, RefreshCw, Send, Download, Monitor } from 'lucide-react';
import Modal from '../components/Modal.js';
import { createHandoff, fetchHandoff, importConversation, type HandoffMessage } from '../lib/api.js';

export interface Transcript {
  title: string | null;
  skillId: string | null;
  messages: HandoffMessage[];
}

interface Props {
  /** The current conversation's transcript, or null when there's nothing open. */
  transcript: Transcript | null;
  onClose: () => void;
  /** Called with the new conversation id after a code is redeemed here. */
  onRedeemed: (conversationId: string) => void;
}

type Tab = 'send' | 'receive';

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const tabBtn = (active: boolean) =>
  `flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
    active ? 'bg-elev/[0.1] text-ink-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]' : 'text-ink-400 hover:text-ink-200'
  }`;

export default function ContinueModal({ transcript, onClose, onRedeemed }: Props) {
  const canSend = !!transcript && transcript.messages.length > 0;
  const [tab, setTab] = useState<Tab>(canSend ? 'send' : 'receive');

  return (
    <Modal title="Continue elsewhere" onClose={onClose}>
      <div className="flex flex-col gap-4 p-4 text-sm text-ink-100">
        <div className="flex gap-1 rounded-xl border border-elev/10 bg-elev/[0.03] p-1">
          <button type="button" className={tabBtn(tab === 'send')} onClick={() => setTab('send')}>
            <Send size={13} /> Send this chat
          </button>
          <button type="button" className={tabBtn(tab === 'receive')} onClick={() => setTab('receive')}>
            <Download size={13} /> Bring a chat here
          </button>
        </div>

        {tab === 'send' ? <SendTab transcript={transcript} canSend={canSend} /> : <ReceiveTab onRedeemed={onRedeemed} />}
      </div>
    </Modal>
  );
}

function SendTab({ transcript, canSend }: { transcript: Transcript | null; canSend: boolean }) {
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useCallback(async () => {
    if (!transcript) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createHandoff({
        title: transcript.title,
        skillId: transcript.skillId,
        messages: transcript.messages,
      });
      setCode(res.code);
      setExpiresAt(res.expiresAt);
      setRemaining(res.expiresAt - Date.now()); // seed so the first render isn't a false "expired"
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create a code.');
    } finally {
      setBusy(false);
    }
  }, [transcript]);

  // Live countdown to the code's expiry.
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setRemaining(expiresAt - Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const expired = !!code && remaining <= 0;

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the code is still visible to copy by hand */
    }
  }

  if (!canSend) {
    return (
      <p className="rounded-lg border border-dashed border-elev/10 px-3 py-6 text-center text-xs text-ink-400">
        Open a chat (or send a message) first, then come back here to continue it on another device.
      </p>
    );
  }

  if (!code) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs leading-relaxed text-ink-300">
          Get a one-time code to pick this chat up in the Cascade desktop app. The transcript is held briefly to
          transfer it, then discarded — nothing is stored.
        </p>
        {error && <p className="text-xs text-danger-400">{error}</p>}
        <button
          type="button"
          onClick={create}
          disabled={busy}
          className="flex items-center justify-center gap-2 rounded-lg bg-accent-500 px-3 py-2.5 text-xs font-semibold text-white hover:bg-accent-400 disabled:opacity-40"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
          Create a code
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-center gap-2 rounded-xl border border-elev/10 bg-elev/[0.04] px-4 py-5">
        <motion.button
          type="button"
          onClick={copy}
          whileTap={{ scale: 0.97 }}
          className="group flex items-center gap-3"
          title="Copy code"
        >
          <span className={`font-mono text-3xl font-bold tracking-[0.2em] ${expired ? 'text-ink-500 line-through' : 'text-ink-50'}`}>
            {code}
          </span>
          <span className="text-ink-400 group-hover:text-ink-100">
            {copied ? <Check size={18} className="text-success-400" /> : <Copy size={18} />}
          </span>
        </motion.button>
        {expired ? (
          <span className="text-xs font-medium text-danger-400">Code expired — create a new one.</span>
        ) : (
          <span className="font-mono text-[11px] text-ink-400">expires in {formatRemaining(remaining)}</span>
        )}
      </div>

      <ol className="flex flex-col gap-1.5 text-xs text-ink-300">
        <li className="flex gap-2"><Monitor size={14} className="mt-0.5 shrink-0 text-ink-400" /> Open the Cascade desktop app.</li>
        <li className="flex gap-2"><span className="w-3.5 shrink-0" /> Go to <span className="font-medium text-ink-100">Continue elsewhere → Bring a chat here</span>.</li>
        <li className="flex gap-2"><span className="w-3.5 shrink-0" /> Enter this code to keep going where you left off.</li>
      </ol>

      <button
        type="button"
        onClick={create}
        disabled={busy}
        className="flex items-center justify-center gap-1.5 rounded-lg border border-elev/10 px-3 py-2 text-xs font-medium text-ink-200 hover:bg-elev/[0.06] disabled:opacity-40"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} New code
      </button>
    </div>
  );
}

function ReceiveTab({ onRedeemed }: { onRedeemed: (conversationId: string) => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function redeem() {
    const code = value.trim();
    if (!code || busy) return;
    setBusy(true);
    setError(null);
    try {
      const snap = await fetchHandoff(code);
      const { conversation } = await importConversation({
        title: snap.title,
        skillId: snap.skillId,
        messages: snap.messages,
      });
      onRedeemed(conversation.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That code is invalid or has expired.');
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-ink-300">
        Enter a code from another device to bring that chat here as a new conversation you can continue.
      </p>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void redeem(); } }}
        placeholder="XXXX-XXXX"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        className="w-full rounded-lg border border-elev/10 bg-elev/[0.04] px-3 py-2.5 text-center font-mono text-lg uppercase tracking-[0.2em] text-ink-50 outline-none placeholder:text-ink-500 focus:border-accent-500/40"
      />
      {error && <p className="text-xs text-danger-400">{error}</p>}
      <button
        type="button"
        onClick={redeem}
        disabled={busy || !value.trim()}
        className="flex items-center justify-center gap-2 rounded-lg bg-accent-500 px-3 py-2.5 text-xs font-semibold text-white hover:bg-accent-400 disabled:opacity-40"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
        Continue this chat
      </button>
    </div>
  );
}
