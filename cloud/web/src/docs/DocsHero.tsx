import { useEffect, useRef, useState } from 'react';
import CascadeMark from '../components/CascadeMark.js';
import type { HeroPalette, HeroScene } from './heroScene.js';

/** The tier colours as the current theme has them (index.css: space-separated RGB channels). */
export function readPalette(): HeroPalette {
  const css = getComputedStyle(document.documentElement);
  const tier = (name: string, fallback: string) => {
    const v = css.getPropertyValue(name).trim().split(/\s+/);
    return v.length === 3 && v.every((n) => /^\d+$/.test(n)) ? `rgb(${v.join(',')})` : fallback;
  };
  return {
    tiers: [tier('--c-t1', '#6FA3FF'), tier('--c-t2', '#4CC3EC'), tier('--c-t3', '#3EDFC9')],
    dark: document.documentElement.dataset.theme !== 'light',
  };
}

/**
 * The docs home's 3D mark. three.js is fetched only here, only when the page is
 * the docs home, and only for a visitor who has not asked for less motion.
 * Without WebGL, with motion reduced, or while the chunk loads, the static mark
 * is what shows, so the page never has a hole in it.
 */
export default function DocsHero({ still, theme }: { still: boolean; theme: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box) return;
    let disposed = false;
    let scene: HeroScene | null = null;
    let visible = true;
    const sync = () => scene?.setActive(visible && !document.hidden);
    let io: IntersectionObserver | undefined;
    const onMove = (e: PointerEvent) => {
      const r = box.getBoundingClientRect();
      scene?.setPointer(((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1, ((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1);
    };

    import('./heroScene.js').then(({ createDocsHero }) => {
      if (disposed) return;
      scene = createDocsHero(canvas, readPalette(), { still });
      if (!scene) return;
      setLive(true);
      if (still) return;
      if (typeof IntersectionObserver !== 'undefined') {
        io = new IntersectionObserver((entries) => { visible = entries.some((e) => e.isIntersecting); sync(); });
        io.observe(box);
      }
      document.addEventListener('visibilitychange', sync);
      box.addEventListener('pointermove', onMove, { passive: true });
    }).catch(() => { /* the chunk failed to load: the static mark stays */ });

    return () => {
      disposed = true;
      io?.disconnect();
      document.removeEventListener('visibilitychange', sync);
      box.removeEventListener('pointermove', onMove);
      scene?.dispose();
      setLive(false);
    };
  }, [still, theme]);

  return (
    <div ref={boxRef} className="relative h-full w-full" data-testid="docs-hero" data-live={live ? '1' : '0'} aria-hidden="true">
      <canvas ref={canvasRef} className={`absolute inset-0 h-full w-full transition-opacity duration-500 ${live ? 'opacity-100' : 'opacity-0'}`} />
      {!live && (
        <div className="absolute inset-0 flex items-center justify-center text-ink-300">
          <CascadeMark size={96} animate={false} />
        </div>
      )}
    </div>
  );
}
