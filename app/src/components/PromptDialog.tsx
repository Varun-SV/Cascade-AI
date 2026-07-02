import { useState, useEffect, useRef } from 'react';

interface Props {
  title: string;
  /** Pre-filled input value (e.g. current name when renaming). */
  defaultValue?: string;
  /** Confirm-only mode: no text input, OK/Cancel just answers the question. */
  confirmOnly?: boolean;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/**
 * Minimal in-app replacement for window.prompt / window.confirm — Electron
 * does not support window.prompt at all (it silently no-ops), which made the
 * file tree's New File / New Folder / Rename actions appear dead.
 */
export function PromptDialog({ title, defaultValue = '', confirmOnly, confirmLabel = 'OK', onSubmit, onCancel }: Props) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  const submit = () => {
    if (confirmOnly) { onSubmit(''); return; }
    if (value.trim()) onSubmit(value.trim());
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const btnStyle = (primary: boolean): React.CSSProperties => ({
    padding: '6px 14px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
    background: primary ? 'linear-gradient(135deg, var(--accent), var(--accent-2))' : 'var(--bg-raised)',
    color: primary ? '#fff' : 'var(--text)',
    border: primary ? 'none' : '1px solid var(--border)',
  });

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onCancel}
    >
      <div
        style={{ width: 320, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 10, boxShadow: 'var(--shadow-3)', padding: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 10 }}>{title}</div>
        {!confirmOnly && (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            style={{ width: '100%', boxSizing: 'border-box', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 10px', fontSize: 12.5, outline: 'none', marginBottom: 12 }}
          />
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: confirmOnly ? 4 : 0 }}>
          <button style={btnStyle(false)} onClick={onCancel}>Cancel</button>
          <button style={btnStyle(true)} onClick={submit} disabled={!confirmOnly && !value.trim()}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
