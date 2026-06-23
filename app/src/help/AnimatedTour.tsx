import { useEffect, useRef, useState } from 'react';
import { Play, Pause, RotateCcw, ChevronLeft, ChevronRight } from 'lucide-react';
import type { TourStep } from './types.js';

interface Props { steps: TourStep[]; title: string }

const STEP_MS = 5000;
const TIERS = [
  { id: 'T1', label: 'Planner', color: 'var(--t1)' },
  { id: 'T2', label: 'Manager', color: 'var(--t2)' },
  { id: 'T3', label: 'Worker', color: 'var(--t3)' },
];

/**
 * A self-contained animated walkthrough that auto-plays a tutorial's steps as a
 * narrated sequence — an in-app substitute for a rendered tutorial video. It
 * reuses the existing per-context `steps` (no external assets) and animates a
 * stylized Cascade stage (tier chips lighting up in sequence) beneath the
 * current step caption.
 */
export function AnimatedTour({ steps, title }: Props) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [progress, setProgress] = useState(0);
  const startRef = useRef<number>(Date.now());

  const count = steps.length;
  const activeTier = count > 0 ? Math.floor((index / count) * TIERS.length) : 0;

  // Drive auto-advance + the progress bar with a single rAF loop so pausing and
  // manual navigation stay in sync.
  useEffect(() => {
    if (!playing || count === 0) return;
    startRef.current = Date.now();
    let raf = 0;
    const tick = () => {
      const elapsed = Date.now() - startRef.current;
      const pct = Math.min(1, elapsed / STEP_MS);
      setProgress(pct);
      if (pct >= 1) {
        setIndex((i) => (i + 1) % count);
        startRef.current = Date.now();
        setProgress(0);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, index, count]);

  const go = (next: number) => {
    setIndex(((next % count) + count) % count);
    setProgress(0);
    startRef.current = Date.now();
  };
  const restart = () => { go(0); setPlaying(true); };

  if (count === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <style>{`
        @keyframes tourPulse { 0%,100% { transform: scale(1); opacity: 0.55 } 50% { transform: scale(1.06); opacity: 1 } }
        @keyframes tourFloat { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-4px) } }
      `}</style>

      {/* Stage */}
      <div style={{
        position: 'relative', aspectRatio: '16/9', borderRadius: 10, overflow: 'hidden',
        background: 'radial-gradient(120% 120% at 50% 0%, var(--bg-raised) 0%, var(--bg-base) 70%)',
        border: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18,
      }}>
        {/* Brand mark */}
        <div style={{
          width: 44, height: 44, borderRadius: 12,
          background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22, color: '#fff', boxShadow: 'var(--glow-accent)',
          animation: 'tourFloat 4s ease-in-out infinite',
        }}>◈</div>

        {/* Tier chips lighting up in sequence */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {TIERS.map((t, i) => {
            const on = i <= activeTier;
            return (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{
                  padding: '6px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700,
                  color: on ? '#fff' : 'var(--text-dim)',
                  background: on ? `color-mix(in srgb, ${t.color} 22%, transparent)` : 'var(--bg-raised)',
                  border: `1px solid ${on ? t.color : 'var(--border)'}`,
                  boxShadow: i === activeTier ? `0 0 16px color-mix(in srgb, ${t.color} 50%, transparent)` : 'none',
                  animation: i === activeTier ? 'tourPulse 1.6s ease-in-out infinite' : 'none',
                  transition: 'all 0.4s var(--ease)',
                }}>
                  {t.id} · {t.label}
                </div>
                {i < TIERS.length - 1 && (
                  <div style={{ width: 18, height: 2, borderRadius: 2, background: i < activeTier ? t.color : 'var(--border)', transition: 'background 0.4s var(--ease)' }} />
                )}
              </div>
            );
          })}
        </div>

        {/* Step counter pill */}
        <div style={{
          position: 'absolute', top: 10, left: 12, fontSize: 10, fontWeight: 600,
          color: 'var(--text-muted)', background: 'var(--bg-surface)',
          border: '1px solid var(--border)', borderRadius: 20, padding: '3px 9px',
        }}>
          {title} · {index + 1}/{count}
        </div>
      </div>

      {/* Caption — fades between steps */}
      <div key={index} style={{
        minHeight: 64, background: 'var(--bg-raised)', border: '1px solid var(--border)',
        borderRadius: 8, padding: '12px 14px', animation: 'fadeIn 0.35s var(--ease)',
      }}>
        <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text)' }}>{steps[index].content}</div>
      </div>

      {/* Progress + controls */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ height: 3, borderRadius: 3, background: 'var(--bg-raised)', overflow: 'hidden' }}>
          <div style={{
            height: '100%', width: `${progress * 100}%`,
            background: 'linear-gradient(90deg, var(--accent), var(--accent-2))',
            transition: 'width 0.1s linear',
          }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
          <IconBtn title="Previous" onClick={() => go(index - 1)}><ChevronLeft size={16} /></IconBtn>
          <IconBtn title={playing ? 'Pause' : 'Play'} onClick={() => { setPlaying((p) => !p); startRef.current = Date.now(); }} accent>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </IconBtn>
          <IconBtn title="Next" onClick={() => go(index + 1)}><ChevronRight size={16} /></IconBtn>
          <IconBtn title="Restart" onClick={restart}><RotateCcw size={14} /></IconBtn>
        </div>
      </div>
    </div>
  );
}

function IconBtn({ children, onClick, title, accent }: { children: React.ReactNode; onClick: () => void; title: string; accent?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: accent ? 36 : 30, height: accent ? 36 : 30, borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        color: accent ? '#fff' : 'var(--text-muted)',
        background: accent ? 'linear-gradient(135deg, var(--accent), var(--accent-2))' : 'var(--bg-raised)',
        border: accent ? 'none' : '1px solid var(--border)',
        boxShadow: accent ? 'var(--shadow-1)' : 'none',
        transition: 'color var(--dur), transform var(--dur)',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; if (!accent) (e.currentTarget as HTMLElement).style.color = 'var(--text)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.transform = 'none'; if (!accent) (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'; }}
    >
      {children}
    </button>
  );
}
