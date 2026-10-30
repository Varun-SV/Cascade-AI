/**
 * The Descent — the landing page's 3D scene.
 *
 * The Cascade mark's three arcs are built as structures in space, and the
 * page's scroll drives one continuous camera flight down through them: a
 * visitor's prompt falls onto T1's arc, splits into three managers on T2's,
 * fans out into seven workers on T3's, rejoins as one result, and the camera
 * pulls back until the arcs line up into the logo itself.
 *
 * Everything here is imperative three.js, imported dynamically by
 * DescentLanding so the chat bundle never carries it. The scene owns its own
 * render loop and smooths the scroll position; the page reads that smoothed
 * position back through `onFrame` to time its chapter text.
 */
import * as THREE from 'three';

export interface DescentPlan {
  sections: [string, string, string];
  tools: string[]; // seven, one per worker
  file: string;
}

export interface DescentScene {
  /** Scroll progress through the descent, 0…1 (the scene eases towards it). */
  setTarget(p: number): void;
  /** The visitor's own prompt, and the plan its labels come from. */
  setPrompt(text: string, plan: DescentPlan): void;
  /** Re-render once at the final logo frame (reduced motion). */
  renderStill(): void;
  /**
   * Whether the scene is on screen. While it is not (the content below the
   * descent covers the fixed canvas), no frames are scheduled at all.
   */
  setActive(active: boolean): void;
  dispose(): void;
}

interface Options {
  /** Called once per frame with the smoothed progress the scene is drawing. */
  onFrame?: (p: number) => void;
  /** Draw one frame and stop: for visitors who asked for less motion. */
  still?: boolean;
}

// Geometry of the mark (CascadeMark.tsx, viewBox 24) in world units, centred.
const ARC_POINTS: Array<[[number, number], [number, number], [number, number]]> = [
  [[-8.5, 4.5], [0, -2.5], [8.5, 4.5]],
  [[-5.75, -0.5], [0, -5.75], [5.75, -0.5]],
  [[-3, -5.5], [0, -8.5], [3, -5.5]],
];
const PARENT = [0, 0, 1, 1, 1, 2, 2];
const SIDE = [-0.5, 0.5, -1, 0, 1, -0.5, 0.5];
const PAIRS: Array<[number, number]> = [[0, 0], [0, 1], [1, 2], [1, 3], [1, 4], [2, 5], [2, 6]];
const PEERS: Array<[number, number]> = [[1, 2], [3, 5], [4, 6], [0, 3]];
const SERIF = '"Source Serif 4 Variable", "Source Serif 4", Georgia, serif';
const MONO = '"Geist Mono Variable", "Geist Mono", ui-monospace, monospace';

const cl = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const seg = (p: number, a: number, b: number) => cl((p - a) / (b - a));
const ease = (x: number) => x * x * (3 - 2 * x);

function radialTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.18, 'rgba(255,255,255,.85)');
  r.addColorStop(0.45, 'rgba(255,255,255,.22)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function ringTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.strokeStyle = '#fff';
  g.lineWidth = 5;
  g.beginPath();
  g.arc(64, 64, 56, 0, Math.PI * 2);
  g.stroke();
  return new THREE.CanvasTexture(c);
}

function label(text: string, o: { h: number; color?: string; mono?: boolean; size?: number }): THREE.Sprite {
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const fs = o.size ?? 44;
  const font = o.mono ? `500 ${fs}px ${MONO}` : `400 ${fs}px ${SERIF}`;
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 48;
  c.width = w;
  c.height = fs * 2;
  g.font = font;
  const r = c.height / 2;
  g.fillStyle = 'rgba(22,26,34,.86)';
  g.beginPath();
  g.moveTo(r, 0);
  g.lineTo(w - r, 0);
  g.arc(w - r, r, r, -Math.PI / 2, Math.PI / 2);
  g.lineTo(r, c.height);
  g.arc(r, r, r, Math.PI / 2, Math.PI * 1.5);
  g.fill();
  g.fillStyle = o.color ?? '#F5F6F9';
  g.textBaseline = 'middle';
  g.fillText(text, 24, c.height / 2);
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, fog: false }));
  s.scale.set((o.h * w) / c.height, o.h, 1);
  return s;
}

function resultCard(file: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 720;
  c.height = 440;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(22,26,34,.94)';
  g.beginPath();
  g.roundRect(0, 0, 720, 440, 28);
  g.fill();
  g.fillStyle = '#808693';
  g.font = `500 22px ${MONO}`;
  g.fillText('EXAMPLE RESULT', 40, 58);
  g.fillStyle = '#F5F6F9';
  g.font = `400 40px ${SERIF}`;
  g.fillText(file, 40, 118);
  const rows: Array<[string, string, string]> = [
    ['T1', 'plan · 3 sections', '#6FA3FF'],
    ['T2', '3 managers', '#4CC3EC'],
    ['T3', '7 workers, in parallel', '#3EDFC9'],
  ];
  g.font = `400 24px ${MONO}`;
  rows.forEach(([tier, text, color], i) => {
    const y = 200 + i * 58;
    g.fillStyle = color;
    g.beginPath();
    g.arc(50, y - 8, 7, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#C4C8D1';
    g.fillText(`${tier}  ${text}`, 70, y);
  });
  g.strokeStyle = 'rgba(233,235,240,.16)';
  g.setLineDash([6, 8]);
  g.beginPath();
  g.moveTo(40, 368);
  g.lineTo(680, 368);
  g.stroke();
  g.fillStyle = '#3EDFC9';
  // A walkthrough, not a run: nothing the visitor typed was sent anywhere.
  g.fillText('simulated · sign in to run it', 40, 408);
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, fog: false }));
  s.scale.set(3.6, 2.2, 1);
  return s;
}

export function createDescentScene(canvas: HTMLCanvasElement, opts: Options = {}): DescentScene | null {
  let R: THREE.WebGLRenderer;
  try {
    R = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch {
    return null;
  }
  // Colours are authored as display (sRGB) values throughout, shaders
  // included, so render without colour management: what is written is shown.
  THREE.ColorManagement.enabled = false;
  R.outputColorSpace = THREE.LinearSRGBColorSpace;
  R.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  R.setClearColor(0x0a0d12, 1);

  const scene = new THREE.Scene();
  const fog = new THREE.FogExp2(0x0a0d12, 0.018);
  scene.fog = fog;
  const cam = new THREE.PerspectiveCamera(45, 1, 0.05, 300);
  const C1 = new THREE.Color('#6FA3FF'), C2 = new THREE.Color('#4CC3EC'), C3 = new THREE.Color('#3EDFC9'), WH = new THREE.Color('#F5F6F9');
  const TIERC = [C1, C2, C3];
  const GLOW = radialTexture(), RING = ringTexture();
  const disposables: Array<{ dispose(): void }> = [GLOW, RING];
  const track = <T extends { dispose(): void }>(x: T): T => { disposables.push(x); return x; };

  // ---- the logo's arcs as structures ----
  const arcs = ARC_POINTS.map((a, i) => {
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(a[0][0], a[0][1], 0), new THREE.Vector3(a[1][0], a[1][1], 0), new THREE.Vector3(a[2][0], a[2][1], 0));
    const mat = track(new THREE.ShaderMaterial({
      uniforms: { uC: { value: TIERC[i] }, uLit: { value: 0 } },
      vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv=modelViewMatrix*vec4(position,1.); vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }',
      fragmentShader: 'uniform vec3 uC; uniform float uLit; varying vec3 vN; varying vec3 vV; void main(){ float d=max(dot(vN,vV),0.); float f=1.-d; float core=pow(d,6.);'
        + ' vec3 col = uC*(.42+.55*f) + vec3(1.)*core*(.25+.45*uLit) + uC*pow(f,3.)*.8; gl_FragColor=vec4(col,1.); }',
    }));
    scene.add(new THREE.Mesh(track(new THREE.TubeGeometry(curve, 200, 0.3, 32, false)), mat));
    const halo = new THREE.Mesh(track(new THREE.TubeGeometry(curve, 160, 0.75, 16, false)),
      track(new THREE.MeshBasicMaterial({ color: TIERC[i], transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false })));
    scene.add(halo);
    scene.add(new THREE.Mesh(track(new THREE.TubeGeometry(curve, 160, 1.4, 16, false)),
      track(new THREE.MeshBasicMaterial({ color: TIERC[i], transparent: true, opacity: 0.018, blending: THREE.AdditiveBlending, depthWrite: false }))));
    const capGeo = track(new THREE.SphereGeometry(0.3, 24, 16));
    for (const end of [0, 1]) { const cap = new THREE.Mesh(capGeo, mat); cap.position.copy(curve.getPoint(end)); scene.add(cap); }
    const pulses = [0, 1, 2].map((k) => {
      const s = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: GLOW, color: WH, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
      s.scale.set(1.3, 1.3, 1);
      scene.add(s);
      return { s, o: k / 3 };
    });
    return { curve, x0: a[0][0], x2: a[2][0], halo, mat, pulses };
  });
  const onArc = (i: number, t: number, lift = 0.42) => { const p = arcs[i].curve.getPoint(cl(t)); p.y += lift; return p; };
  const tForX = (i: number, x: number) => (x - arcs[i].x0) / (arcs[i].x2 - arcs[i].x0);

  // ---- ambient: stars, and a falling sheet of light shaped like the mark ----
  {
    const n = 1600, p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 50 + Math.random() * 90, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      p.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.7, r * Math.sin(ph) * Math.sin(th) - 20], i * 3);
    }
    const g = track(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    scene.add(new THREE.Points(g, track(new THREE.PointsMaterial({ color: 0x9aa6bf, size: 0.18, transparent: true, opacity: 0.6, fog: false }))));
  }
  const FALL_N = 2600;
  const fallU = { uTime: { value: 0 }, uOp: { value: 0.22 }, uPR: { value: R.getPixelRatio() }, c1: { value: C1 }, c2: { value: C2 }, c3: { value: C3 } };
  {
    const g = track(new THREE.BufferGeometry()), seed = new Float32Array(FALL_N), off = new Float32Array(FALL_N);
    for (let i = 0; i < FALL_N; i++) { seed[i] = Math.random(); off[i] = Math.random(); }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FALL_N * 3), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    g.setAttribute('aOff', new THREE.BufferAttribute(off, 1));
    const m = track(new THREE.ShaderMaterial({
      uniforms: fallU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: 'attribute float aSeed; attribute float aOff; uniform float uTime; uniform float uPR; varying float vY; varying float vA;'
        + ' void main(){ float t=fract(uTime*.045+aOff); float y=9.-t*21.;'
        + ' float w=y>4.5?8.8:(y>-.5?mix(5.9,8.8,(y+.5)/5.):(y>-5.5?mix(3.1,5.9,(y+5.5)/5.):mix(.15,3.1,clamp((y+11.)/5.5,0.,1.))));'
        + ' float x=(aSeed*2.-1.)*w + sin(uTime*.7+aSeed*40.)*.08; float z=(fract(aSeed*13.37)-.5)*1.6; vY=y; vA=.35+.65*fract(aSeed*7.7);'
        + ' vec4 mv=modelViewMatrix*vec4(x,y,z,1.); gl_Position=projectionMatrix*mv; gl_PointSize=min((1.2+fract(aSeed*3.1)*1.8)*uPR*(14./-mv.z), 9.*uPR); }',
      fragmentShader: 'uniform float uOp; uniform vec3 c1; uniform vec3 c2; uniform vec3 c3; varying float vY; varying float vA;'
        + ' void main(){ float d=length(gl_PointCoord-.5); if(d>.5) discard; vec3 col = vY>1.? c1 : (vY>-3.6? c2 : c3); gl_FragColor=vec4(col, pow(1.-d*2.,1.5)*vA*uOp); }',
    }));
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    scene.add(pts);
  }

  // ---- the run: one drop, three managers, seven workers, one result ----
  const coreGeo = track(new THREE.SphereGeometry(0.32, 24, 16));
  const coreMat = track(new THREE.MeshBasicMaterial({ color: WH }));
  const drop = (color: THREE.Color, size: number) => {
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.scale.setScalar(size);
    const gl = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: GLOW, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
    gl.scale.set(size * 3.2, size * 3.2, 1);
    const o = new THREE.Group();
    o.add(core, gl);
    scene.add(o);
    return o;
  };
  const lead = drop(WH, 1.05);
  const mgr = [0, 1, 2].map(() => drop(C2, 0.7));
  const wk = PARENT.map(() => drop(C3, 0.5));
  const result = drop(C3, 1.6);
  const mgrX2 = [0.24, 0.5, 0.76].map((t) => onArc(0, t).x * 0.62);
  const mgrT1 = [0.24, 0.5, 0.76];
  const wkX3 = PARENT.map((_, k) => -2.55 + k * 0.85);
  const RESULT_P = new THREE.Vector3(0, -10.6, 0);

  const ring = (color: THREE.Color) => {
    const s = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: RING, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 })));
    scene.add(s);
    return s;
  };
  const ringLead = ring(WH), ringM = mgr.map(() => ring(C2)), ringW = wk.map(() => ring(C3)), ringR = ring(C3);

  // Comms threads between managers and workers, and between workers.
  const nLines = PAIRS.length + PEERS.length;
  const linePos = new Float32Array(nLines * 6), lineCol = new Float32Array(nLines * 6);
  const lineGeo = track(new THREE.BufferGeometry());
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
  lineGeo.setAttribute('color', new THREE.BufferAttribute(lineCol, 3));
  const lines = new THREE.LineSegments(lineGeo, track(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
  lines.frustumCulled = false;
  scene.add(lines);
  // Sparks while the workers work.
  const SPK = 280, spkPos = new Float32Array(SPK * 3);
  const spk = Array.from({ length: SPK }, (_, i) => ({ k: i % 7, ph: Math.random(), dir: new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.1, Math.random() - 0.5).normalize() }));
  const spkGeo = track(new THREE.BufferGeometry());
  spkGeo.setAttribute('position', new THREE.BufferAttribute(spkPos, 3));
  const spkMat = track(new THREE.PointsMaterial({ map: GLOW, color: C3, size: 0.16, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  const spks = new THREE.Points(spkGeo, spkMat);
  spks.frustumCulled = false;
  scene.add(spks);

  // ---- labels that carry the visitor's own prompt ----
  let promptSprite: THREE.Sprite | null = null, card: THREE.Sprite | null = null;
  let secSprites: THREE.Sprite[] = [], toolSprites: THREE.Sprite[] = [];
  const dropSprite = (s: THREE.Sprite | null) => { if (!s) return; scene.remove(s); s.material.map?.dispose(); s.material.dispose(); };
  function setPrompt(text: string, plan: DescentPlan) {
    [promptSprite, card, ...secSprites, ...toolSprites].forEach(dropSprite);
    const shown = text.length > 46 ? `${text.slice(0, 45)}…` : text;
    promptSprite = label(`“${shown}”`, { h: 0.42 });
    secSprites = plan.sections.map((t) => label(t, { h: 0.34, color: '#4CC3EC' }));
    toolSprites = plan.tools.slice(0, 7).map((t) => label(t, { h: 0.24, mono: true, size: 36, color: '#3EDFC9' }));
    card = resultCard(plan.file);
    [promptSprite, card, ...secSprites, ...toolSprites].forEach((s) => scene.add(s));
  }

  // ---- the camera's flight ----
  let posCurve: THREE.CatmullRomCurve3, lookCurve: THREE.CatmullRomCurve3, KP: number[] = [];
  function buildPath(asp: number) {
    const endZ = Math.max(31, 11.5 / (Math.tan((22.5 * Math.PI) / 180) * asp));
    const narrow = asp < 0.8;
    const keys: Array<[number, number[], number[]]> = [
      [0, [2.2, 14.2, 7.5], [0, 11.0, 0]],
      [0.11, [4.6, 4.4, 9.5], [0, 1.8, 0]],
      [0.22, [-6.5, 3.2, 10.5], [0, 1.2, 0]],
      [0.35, [-3.2, -0.6, 9.2], [0, -2.6, 0]],
      [0.47, [5.2, -3.2, 8.4], [0, -3.4, 0]],
      [0.59, [2.6, -5.6, 7.2], [0, -6.6, 0]],
      [0.73, [-3.8, -7.4, 6.8], [0, -6.9, 0]],
      [0.85, [1.6, -9.4, 7.8], [0, -10.2, 0]],
      [0.93, [0, -5.5, narrow ? endZ * 0.6 : 19], [0, -4.5, 0]],
      [1, [0, narrow ? -7.4 : -6.4, endZ], [0, narrow ? -7.4 : -6.4, 0]],
    ];
    if (narrow) keys.forEach((k, i) => { if (i < 8) { k[1][2] *= 1.35; k[1][0] *= 0.7; } });
    KP = keys.map((k) => k[0]);
    posCurve = new THREE.CatmullRomCurve3(keys.map((k) => new THREE.Vector3().fromArray(k[1])), false, 'centripetal');
    lookCurve = new THREE.CatmullRomCurve3(keys.map((k) => new THREE.Vector3().fromArray(k[2])), false, 'centripetal');
  }
  const pathU = (p: number) => {
    for (let i = 0; i < KP.length - 1; i++) {
      if (p <= KP[i + 1]) { let f = (p - KP[i]) / (KP[i + 1] - KP[i]); f = f * f * (3 - 2 * f); return (i + f) / (KP.length - 1); }
    }
    return 1;
  };

  // ---- the state of everything at a scroll position ----
  const V = new THREE.Vector3(), V2 = new THREE.Vector3(), TOP = new THREE.Vector3(0, 12.8, 0);
  const mgrPos = mgr.map(() => new THREE.Vector3()), wkPos = wk.map(() => new THREE.Vector3());
  const fall = (from: THREE.Vector3, to: THREE.Vector3, k: number, out: THREE.Vector3) => {
    out.lerpVectors(from, to, k);
    out.y = from.y + (to.y - from.y) * k * k;
    return out;
  };
  const fade = (s: THREE.Sprite | null, op: number) => { if (!s) return; s.material.opacity = op; s.visible = op > 0.01; };

  function stateAt(p: number, t: number) {
    const hit = onArc(0, 0.5);
    const kL = seg(p, 0, 0.11);
    fall(TOP, hit, kL, lead.position);
    lead.position.y += Math.sin(t * 2) * 0.05 * (1 - kL);
    lead.visible = p < 0.135;
    lead.scale.setScalar(1 - seg(p, 0.11, 0.135) * 0.6);
    ringLead.position.copy(hit);
    const rk = seg(p, 0.105, 0.17);
    ringLead.scale.setScalar(0.5 + rk * 5);
    fade(ringLead, (1 - rk) * (rk > 0 ? 0.9 : 0));
    promptSprite?.position.set(lead.position.x, lead.position.y + 0.95, lead.position.z);
    fade(promptSprite, seg(p, 0.012, 0.035) * (1 - seg(p, 0.09, 0.13)));

    mgr.forEach((m, i) => {
      const a = onArc(0, 0.5 + (mgrT1[i] - 0.5) * ease(seg(p, 0.12, 0.2))), b = onArc(1, tForX(1, mgrX2[i]));
      fall(a, b, seg(p, 0.2, 0.31), mgrPos[i]);
      if (p > 0.31) mgrPos[i].y += Math.sin(t * 1.6 + i) * 0.06;
      const kR = seg(p, 0.78, 0.88);
      if (kR > 0) { V.copy(mgrPos[i]); mgrPos[i].lerpVectors(V, RESULT_P, ease(kR)); }
      m.position.copy(mgrPos[i]);
      m.visible = p > 0.12 && p < 0.875;
      m.scale.setScalar(Math.max(0.001, ease(seg(p, 0.12, 0.16)) * (1 - seg(p, 0.84, 0.875) * 0.7)));
      ringM[i].position.copy(b);
      const k2 = seg(p, 0.305, 0.36);
      ringM[i].scale.setScalar(0.4 + k2 * 3.2);
      fade(ringM[i], (1 - k2) * (k2 > 0 ? 0.85 : 0));
      const s = secSprites[i];
      if (s) { s.position.set(mgrPos[i].x, mgrPos[i].y + 0.75, mgrPos[i].z); fade(s, seg(p, 0.15, 0.2) * (1 - seg(p, 0.6, 0.66))); }
    });

    wk.forEach((w, k) => {
      const parT = tForX(1, mgrX2[PARENT[k]]);
      const a = onArc(1, parT + SIDE[k] * 0.07 * ease(seg(p, 0.42, 0.5))), b = onArc(2, tForX(2, wkX3[k]));
      fall(a, b, seg(p, 0.5, 0.59), wkPos[k]);
      if (p > 0.59) wkPos[k].y += Math.sin(t * 2.4 + k) * 0.05;
      const kR = seg(p, 0.76, 0.86);
      if (kR > 0) {
        V.copy(wkPos[k]);
        V2.set(wkPos[k].x * 0.5, wkPos[k].y - 1.4, 0);
        const e = ease(kR);
        wkPos[k].set(
          (1 - e) * (1 - e) * V.x + 2 * (1 - e) * e * V2.x + e * e * RESULT_P.x,
          (1 - e) * (1 - e) * V.y + 2 * (1 - e) * e * V2.y + e * e * RESULT_P.y,
          (1 - e) * V.z,
        );
      }
      w.position.copy(wkPos[k]);
      w.visible = p > 0.42 && p < 0.865;
      w.scale.setScalar(Math.max(0.001, ease(seg(p, 0.42, 0.47)) * (1 - seg(p, 0.83, 0.865) * 0.7)));
      ringW[k].position.copy(b);
      const k2 = seg(p, 0.585, 0.64);
      ringW[k].scale.setScalar(0.3 + k2 * 2.2);
      fade(ringW[k], (1 - k2) * (k2 > 0 ? 0.8 : 0));
      const s = toolSprites[k];
      if (s) { s.position.set(wkPos[k].x, wkPos[k].y + 0.55, wkPos[k].z); fade(s, seg(p, 0.58, 0.62) * (1 - seg(p, 0.74, 0.77))); }
    });

    const on = seg(p, 0.36, 0.42) * (1 - seg(p, 0.76, 0.8));
    let j = 0;
    PAIRS.forEach(([m, w], i) => {
      const A = mgrPos[m], B = wkPos[w];
      linePos.set([A.x, A.y, A.z, B.x, B.y, B.z], j * 6);
      const q = (0.35 + 0.65 * Math.max(0, Math.sin(t * 3 + i * 1.7))) * on * (p > 0.44 ? 1 : 0);
      lineCol.set([C2.r * q, C2.g * q, C2.b * q, C3.r * q, C3.g * q, C3.b * q], j * 6);
      j++;
    });
    PEERS.forEach(([x, y], i) => {
      const A = wkPos[x], B = wkPos[y];
      linePos.set([A.x, A.y, A.z, B.x, B.y, B.z], j * 6);
      const q = Math.max(0, Math.sin(t * 2.2 + i * 2.3)) * seg(p, 0.6, 0.64) * (1 - seg(p, 0.74, 0.78));
      lineCol.set([q, q, q, C3.r * q, C3.g * q, C3.b * q], j * 6);
      j++;
    });
    lineGeo.attributes.position.needsUpdate = true;
    lineGeo.attributes.color.needsUpdate = true;

    spkMat.opacity = seg(p, 0.58, 0.62) * (1 - seg(p, 0.74, 0.78)) * 0.9;
    spk.forEach((s, i) => {
      const f = (t * 0.8 + s.ph) % 1, b = wkPos[s.k];
      spkPos.set([b.x + s.dir.x * f * 0.9, b.y + s.dir.y * f * 0.9, b.z + s.dir.z * f * 0.9], i * 3);
    });
    spkGeo.attributes.position.needsUpdate = true;

    const kRes = seg(p, 0.8, 0.88) * (1 - seg(p, 0.9, 0.97));
    result.visible = kRes > 0;
    result.position.copy(RESULT_P);
    result.scale.setScalar(Math.max(0.001, ease(kRes) * (1 + 0.05 * Math.sin(t * 3))));
    ringR.position.copy(RESULT_P);
    const k3 = seg(p, 0.86, 0.93);
    ringR.scale.setScalar(0.6 + k3 * 6);
    fade(ringR, (1 - k3) * (k3 > 0 ? 0.9 : 0));
    card?.position.set(RESULT_P.x + 2.6, RESULT_P.y + 0.6, 0.2);
    fade(card, seg(p, 0.84, 0.88) * (1 - seg(p, 0.92, 0.96)));

    const act = [
      seg(p, 0.08, 0.14) * (1 - seg(p, 0.3, 0.4)),
      seg(p, 0.28, 0.34) * (1 - seg(p, 0.55, 0.64)),
      seg(p, 0.55, 0.6) * (1 - seg(p, 0.78, 0.86)),
    ];
    const end = seg(p, 0.9, 1);
    arcs.forEach((a, i) => {
      (a.halo.material as THREE.MeshBasicMaterial).opacity = 0.06 + act[i] * 0.12 + end * 0.06;
      a.mat.uniforms.uLit.value = act[i] + end;
      a.pulses.forEach((q) => {
        const u = (t * 0.12 + q.o + i * 0.13) % 1;
        q.s.position.copy(a.curve.getPoint(u));
        q.s.material.opacity = (0.35 + act[i] * 0.65) * Math.sin(u * Math.PI);
        q.s.material.color.copy(i === 0 ? WH : TIERC[i]);
      });
    });
    fallU.uOp.value = 0.16 + seg(p, 0.86, 0.98) * 0.9;
    fog.density = 0.018 * (1 - seg(p, 0.86, 1) * 0.9);
  }

  // ---- loop ----
  const mouse = { x: 0, y: 0, sx: 0, sy: 0 };
  const onPointer = (e: PointerEvent) => { mouse.x = e.clientX / window.innerWidth - 0.5; mouse.y = e.clientY / window.innerHeight - 0.5; };
  window.addEventListener('pointermove', onPointer, { passive: true });
  function resize() {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    R.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    buildPath(w / h);
  }
  function render(p: number, t: number) {
    stateAt(p, t);
    const u = pathU(p);
    cam.position.copy(posCurve.getPoint(u));
    const settle = 1 - seg(p, 0.9, 1);
    cam.position.x += mouse.sx * 1.2 * settle;
    cam.position.y -= mouse.sy * 0.8 * settle;
    cam.lookAt(lookCurve.getPoint(u));
    fallU.uTime.value = t;
    R.render(scene, cam);
  }
  const onResize = () => { resize(); if (opts.still) render(1, 4); };
  window.addEventListener('resize', onResize);
  resize();

  // The loop runs only while there is something to see: not in the still
  // layout, not while the page below covers the canvas, not in a background
  // tab. Stopped means NO frames scheduled — an idle rAF that returns early
  // still wakes the page sixty times a second for as long as it stays open.
  let target = 0, pNow = 0, raf = 0, last = performance.now(), tAcc = 0;
  let active = true, running = false;
  function sync() {
    const want = !opts.still && active && !document.hidden;
    if (want && !running) {
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    } else if (!want && running) {
      running = false;
      cancelAnimationFrame(raf);
    }
  }
  document.addEventListener('visibilitychange', sync);
  function frame(now: number) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    tAcc += dt;
    pNow += (target - pNow) * Math.min(1, dt * 5);
    mouse.sx += (mouse.x - mouse.sx) * 0.05;
    mouse.sy += (mouse.y - mouse.sy) * 0.05;
    render(pNow, tAcc);
    opts.onFrame?.(pNow);
  }
  if (opts.still) render(1, 4);
  else sync();

  return {
    setTarget(p) { target = cl(p); },
    setPrompt,
    renderStill() { render(1, 4); },
    setActive(next) { active = next; sync(); },
    dispose() {
      running = false;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('resize', onResize);
      [promptSprite, card, ...secSprites, ...toolSprites].forEach(dropSprite);
      disposables.forEach((d) => d.dispose());
      R.dispose();
      THREE.ColorManagement.enabled = true;
    },
  };
}
