/**
 * Small imperative motion helpers for the chat — the moments framer-motion's
 * declarative props can't express, because they cross components: a drop that
 * leaves the composer's button and lands in the run's Cascade mark.
 *
 * Every helper is a no-op when the visitor asked for less motion, either in
 * the OS (prefers-reduced-motion) or in Settings → Reduce motion, which App
 * mirrors onto <html data-reduce-motion="1">.
 */

export function motionAllowed(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (document.documentElement.dataset['reduceMotion'] === '1') return false;
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function centre(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** A ring that spreads from the middle of `el` and fades — a drop landing. */
export function ripple(el: Element, color = 'rgb(var(--c-t1))'): void {
  if (!motionAllowed() || typeof document.body.animate !== 'function') return;
  const { x, y } = centre(el);
  const r = document.createElement('span');
  r.className = 'cz-ripple';
  r.style.left = `${x}px`;
  r.style.top = `${y}px`;
  r.style.borderColor = color;
  document.body.appendChild(r);
  const a = r.animate(
    [{ transform: 'translate(-50%,-50%) scale(1)', opacity: 0.9 }, { transform: 'translate(-50%,-50%) scale(6)', opacity: 0 }],
    { duration: 700, easing: 'cubic-bezier(.2,.8,.2,1)' },
  );
  a.onfinish = () => r.remove();
}

/**
 * Fly a glowing drop from `from` to `to` along an arc, then ripple where it
 * lands. Resolves when it has landed (immediately when motion is off).
 */
export function flyDrop(from: Element, to: Element, duration = 720): Promise<void> {
  if (!motionAllowed() || typeof document.body.animate !== 'function') return Promise.resolve();
  const a = centre(from), b = centre(to);
  const cx = (a.x + b.x) / 2, cy = Math.min(a.y, b.y) - 140;
  const steps = 18;
  const frames: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const k = i / steps, e = k * k;
    const x = (1 - e) * (1 - e) * a.x + 2 * (1 - e) * e * cx + e * e * b.x;
    const y = (1 - e) * (1 - e) * a.y + 2 * (1 - e) * e * cy + e * e * b.y;
    frames.push({ transform: `translate(${x}px, ${y}px) translate(-50%,-50%) scale(${1 - k * 0.4})`, opacity: k > 0.92 ? (1 - k) * 12 : 1 });
  }
  const d = document.createElement('span');
  d.className = 'cz-drop';
  d.setAttribute('aria-hidden', 'true');
  document.body.appendChild(d);
  return new Promise((resolve) => {
    const anim = d.animate(frames, { duration, easing: 'linear', fill: 'forwards' });
    anim.onfinish = () => { d.remove(); ripple(to); resolve(); };
    anim.oncancel = () => { d.remove(); resolve(); };
  });
}
