/**
 * The docs home's small 3D touch: the Cascade mark's three arcs as tubes, with
 * a few points of light running down each, in the tier colours. It borrows the
 * landing page's geometry (landing/descentScene.ts) and none of its weight: no
 * scroll camera, no labels, a few hundred points, drawn at most 30 times a
 * second, and not at all while it is off screen or the tab is hidden.
 *
 * Imported dynamically by DocsHero, so neither the chat app nor the rest of
 * the docs carries three.js. The background is transparent, so it sits on the
 * page in either theme.
 */
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, Color, ColorManagement, Group, LinearSRGBColorSpace, Mesh, MeshBasicMaterial,
  NormalBlending, PerspectiveCamera, Points, PointsMaterial, QuadraticBezierCurve3, Scene, SphereGeometry,
  TubeGeometry, Vector3, WebGLRenderer,
} from 'three';

/** The mark's arcs (CascadeMark.tsx, viewBox 24) in world units, centred. Widest at the top. */
const ARCS: Array<[[number, number], [number, number], [number, number]]> = [
  [[-8.5, 4.5], [0, -2.5], [8.5, 4.5]],
  [[-5.75, -0.5], [0, -5.75], [5.75, -0.5]],
  [[-3, -5.5], [0, -8.5], [3, -5.5]],
];
const PER_ARC = 34;
const SAMPLES = 160;
const FRAME_MS = 1000 / 30;

export interface HeroPalette {
  /** The three tier colours, as CSS colours (read from the theme). */
  tiers: [string, string, string];
  /** Dark themes glow (additive light); a light theme needs ink, not light. */
  dark: boolean;
}

export interface HeroScene {
  /** Pause or resume drawing (off screen, hidden tab). */
  setActive(active: boolean): void;
  /** Lean the scene a little towards a pointer, -1…1 on each axis. */
  setPointer(x: number, y: number): void;
  dispose(): void;
}

function glowTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.35, 'rgba(255,255,255,.55)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

/**
 * Draw the scene on a canvas. `still` draws one frame and stops (reduced motion).
 * Returns null where there is no WebGL, and the caller shows the static mark.
 */
export function createDocsHero(canvas: HTMLCanvasElement, palette: HeroPalette, opts: { still?: boolean } = {}): HeroScene | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch {
    return null;
  }
  // Colours here are display (sRGB) values, drawn as written, as on the landing page.
  ColorManagement.enabled = false;
  renderer.outputColorSpace = LinearSRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const camera = new PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0.6, 30);
  camera.lookAt(0, 0, 0);

  const group = new Group();
  scene.add(group);

  const disposables: Array<{ dispose(): void }> = [];
  const own = <T extends { dispose(): void }>(x: T): T => { disposables.push(x); return x; };
  const glow = own(glowTexture());
  const blending = palette.dark ? AdditiveBlending : NormalBlending;

  const tables: Vector3[][] = [];
  const clouds = ARCS.map((a, i) => {
    const color = new Color(palette.tiers[i]);
    const curve = new QuadraticBezierCurve3(
      new Vector3(a[0][0], a[0][1], 0), new Vector3(a[1][0], a[1][1], 0), new Vector3(a[2][0], a[2][1], 0));
    tables.push(curve.getPoints(SAMPLES));

    group.add(new Mesh(own(new TubeGeometry(curve, 90, 0.34, 18, false)), own(new MeshBasicMaterial({ color, transparent: true, opacity: palette.dark ? 0.92 : 1 }))));
    group.add(new Mesh(own(new TubeGeometry(curve, 60, 0.95, 12, false)),
      own(new MeshBasicMaterial({ color, transparent: true, opacity: palette.dark ? 0.09 : 0.07, blending, depthWrite: false }))));
    const cap = own(new SphereGeometry(0.34, 16, 12));
    for (const end of [0, 1]) {
      const m = new Mesh(cap, own(new MeshBasicMaterial({ color })));
      m.position.copy(curve.getPoint(end));
      group.add(m);
    }

    // Light running along the arc: a point per particle, each at its own pace.
    const pos = new Float32Array(PER_ARC * 3);
    const geo = own(new BufferGeometry());
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    const pts = new Points(geo, own(new PointsMaterial({
      map: glow, color: palette.dark ? 0xffffff : color, size: 1.15, sizeAttenuation: true, transparent: true,
      opacity: palette.dark ? 0.95 : 0.8, blending, depthWrite: false,
    })));
    pts.frustumCulled = false;
    group.add(pts);
    const phase = Float32Array.from({ length: PER_ARC }, (_, k) => k / PER_ARC);
    const speed = Float32Array.from({ length: PER_ARC }, () => 0.05 + Math.random() * 0.08);
    return { pos, geo, phase, speed, table: tables[i]! };
  });

  function place(time: number) {
    for (const c of clouds) {
      for (let k = 0; k < PER_ARC; k++) {
        const t = (c.phase[k]! + time * c.speed[k]!) % 1;
        const p = c.table[Math.min(SAMPLES, Math.floor(t * SAMPLES))]!;
        c.pos[k * 3] = p.x;
        c.pos[k * 3 + 1] = p.y + 0.55;
        c.pos[k * 3 + 2] = Math.sin(k * 12.9898) * 0.5;
      }
      (c.geo.getAttribute('position') as BufferAttribute).needsUpdate = true;
    }
  }

  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Keep the whole mark in frame however tall or narrow the box is.
    camera.position.z = Math.max(30, 30 * (1.25 / camera.aspect));
    camera.updateProjectionMatrix();
  }
  resize();
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  ro?.observe(canvas);

  let active = !opts.still;
  let raf = 0;
  let last = 0;
  let clock = 0;
  let px = 0, py = 0, tx = 0, ty = 0;
  const frame = (now: number) => {
    raf = 0;
    if (!active) return;
    raf = requestAnimationFrame(frame);
    if (now - last < FRAME_MS) return;
    clock += Math.min(0.1, (now - last) / 1000);
    last = now;
    px += (tx - px) * 0.06;
    py += (ty - py) * 0.06;
    group.rotation.y = Math.sin(clock * 0.28) * 0.42 + px * 0.25;
    group.rotation.x = -0.12 + Math.sin(clock * 0.21) * 0.05 - py * 0.12;
    place(clock);
    renderer.render(scene, camera);
  };

  place(2.2);
  group.rotation.set(-0.12, 0.3, 0);
  renderer.render(scene, camera);
  if (active) raf = requestAnimationFrame(frame);

  return {
    setActive(next) {
      if (opts.still || next === active) return;
      active = next;
      if (active && !raf) raf = requestAnimationFrame(frame);
    },
    setPointer(x, y) { tx = x; ty = y; },
    dispose() {
      active = false;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      for (const d of disposables) d.dispose();
      renderer.dispose();
    },
  };
}
