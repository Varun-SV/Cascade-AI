import { HelpCircle } from 'lucide-react';
import { useAppDispatch } from '../store/index.js';
import { setHelpContext } from '../store/index.js';

interface Props { context: string }

export function HelpButton({ context }: Props) {
  const dispatch = useAppDispatch();
  return (
    <button
      className="help-btn"
      onClick={() => dispatch(setHelpContext(context))}
      title="Help & tutorials"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 24, height: 24, borderRadius: 6,
        background: 'transparent', border: '1px solid var(--border)',
        cursor: 'pointer', color: 'var(--text-muted)',
        transition: 'color 0.15s, border-color 0.15s',
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.color = 'var(--accent)';
        el.style.borderColor = 'var(--accent)';
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.color = 'var(--text-muted)';
        el.style.borderColor = 'var(--border)';
      }}
    >
      <HelpCircle size={13} />
    </button>
  );
}
