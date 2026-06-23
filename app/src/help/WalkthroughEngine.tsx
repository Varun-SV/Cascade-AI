import { useState, useEffect, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Play, X } from 'lucide-react';
import type { TourStep } from './types.js';

interface Props { steps: TourStep[]; context: string }

interface Rect { top: number; left: number; width: number; height: number }

const PAD = 6;          // highlight ring padding around the target
const TIP_W = 280;      // tooltip width
const TIP_GAP = 12;     // gap between target and tooltip

function measure(target: string): Rect | null {
  const el = document.querySelector(target);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/** Compute tooltip position from the target rect + preferred placement, clamped to viewport. */
function tooltipPos(rect: Rect | null, placement: TourStep['placement']): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!rect) return { top: vh / 2 - 60, left: vw / 2 - TIP_W / 2 };

  let top: number;
  let left: number;
  switch (placement) {
    case 'top':
      top = rect.top - TIP_GAP - 90;
      left = rect.left + rect.width / 2 - TIP_W / 2;
      break;
    case 'left':
      top = rect.top + rect.height / 2 - 60;
      left = rect.left - TIP_GAP - TIP_W;
      break;
    case 'right':
      top = rect.top + rect.height / 2 - 60;
      left = rect.left + rect.width + TIP_GAP;
      break;
    case 'bottom':
    default:
      top = rect.top + rect.height + TIP_GAP;
      left = rect.left + rect.width / 2 - TIP_W / 2;
  }

  // Clamp into the viewport with an 8px margin.
  left = Math.max(8, Math.min(left, vw - TIP_W - 8));
  top = Math.max(8, Math.min(top, vh - 140));
  return { top, left };
}

function Overlay({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const step = steps[index];

  const recompute = useCallback(() => {
    setRect(measure(step.target));
  }, [step.target]);

  useLayoutEffect(() => { recompute(); }, [recompute]);

  useEffect(() => {
    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', recompute, true);
    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, true);
    };
  }, [recompute]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, steps.length - 1));
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, steps.length]);

  const isLast = index === steps.length - 1;
  const tip = tooltipPos(rect, step.placement);

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 9000 }}>
      {/* Dimmed backdrop */}
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)' }} />

      {/* Highlight ring around the target */}
      {rect && (
        <div style={{
          position: 'absolute',
          top: rect.top - PAD, left: rect.left - PAD,
          width: rect.width + PAD * 2, height: rect.height + PAD * 2,
          border: '2px solid var(--accent)', borderRadius: 8,
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.6), 0 0 16px rgba(0,0,0,0)',
          pointerEvents: 'none', transition: 'all 0.2s ease',
        }} />
      )}

      {/* Tooltip */}
      <div style={{
        position: 'absolute', top: tip.top, left: tip.left, width: TIP_W,
        background: 'var(--bg-overlay)', border: '1px solid var(--border-strong)', borderRadius: 10,
        padding: 14, boxShadow: 'var(--shadow-3)', color: 'var(--text)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: 0.5 }}>
            STEP {index + 1} / {steps.length}
          </span>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 2 }}
          >
            <X size={14} />
          </button>
        </div>

        <p style={{ fontSize: 13, lineHeight: 1.55, margin: '0 0 14px' }}>{step.content}</p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={onClose}
            style={{ fontSize: 11, color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            Skip tour
          </button>
          <div style={{ flex: 1 }} />
          {index > 0 && (
            <button
              onClick={() => setIndex((i) => i - 1)}
              style={{ fontSize: 12, color: 'var(--text-muted)', background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer', padding: '5px 12px' }}
            >
              Back
            </button>
          )}
          <button
            onClick={() => (isLast ? onClose() : setIndex((i) => i + 1))}
            style={{ fontSize: 12, fontWeight: 600, color: '#fff', background: 'var(--accent)', border: 'none', borderRadius: 6, cursor: 'pointer', padding: '5px 14px' }}
          >
            {isLast ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function WalkthroughEngine({ steps, context }: Props) {
  const [running, setRunning] = useState(false);

  return (
    <div>
      {running && steps.length > 0 && (
        <Overlay steps={steps} onClose={() => setRunning(false)} />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, lineHeight: 1.6 }}>
          This interactive tour highlights the key parts of the <strong style={{ color: 'var(--text)' }}>{context}</strong> view
          and explains what each element does. You can skip at any time.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-muted)' }}>
          <div style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <span style={{ color: '#fff', fontSize: 9, fontWeight: 700 }}>{steps.length}</span>
          </div>
          steps in this tour
        </div>

        <button
          onClick={() => setRunning(true)}
          disabled={steps.length === 0}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '8px 16px', borderRadius: 8,
            background: 'var(--accent)', border: 'none', cursor: steps.length === 0 ? 'default' : 'pointer',
            color: '#fff', fontSize: 13, fontWeight: 600, opacity: steps.length === 0 ? 0.5 : 1,
          }}
        >
          <Play size={14} />
          Start Tour
        </button>
      </div>
    </div>
  );
}
