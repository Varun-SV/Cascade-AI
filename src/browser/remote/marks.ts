// ─────────────────────────────────────────────
//  Cascade AI — Refs drawn on a screenshot (browserVision: marked)
// ─────────────────────────────────────────────
//
//  The experimental "AR" view: each control the page view lists on screen is
//  boxed on the screenshot with its ref, so a model can tie "e14" to the
//  button it sees.
//
//  Drawn on a COPY of the screenshot, never on the page. Boxes injected into
//  the live page are visible to its scripts, can be covered by its own
//  dialogs, can shift its layout, and can be left behind when something fails
//  halfway. Here Chrome decodes the JPEG into an OffscreenCanvas, draws, and
//  encodes it again — inside an isolated world, which the page's scripts
//  cannot see or reach, and without touching the DOM.
//
//  Whether the marks help is what the side-by-side test is for. Until it says
//  they do, `image` (a clean screenshot) is the mode to use.

/** One control to box: its ref, and where it is on screen in CSS pixels. */
export interface Mark {
  ref: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The narrow CDP surface this needs. */
export interface MarkSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** Name of the isolated world the drawing runs in. Shows in DevTools, nowhere else. */
const WORLD = 'cascade-marks';

/**
 * Draws the marks, as source for `Runtime.evaluate`. Plain JavaScript: it runs
 * in the page's renderer, not in Node. The label goes above the box when there
 * is room, else inside it, else below or to the right, wherever it does not
 * cover a label already placed.
 */
const DRAW = `async ({ data, marks, width, height }) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = canvas.getContext('2d');
  g.drawImage(bitmap, 0, 0);
  const sx = bitmap.width / width, sy = bitmap.height / height;
  const COLOR = '#d6006f', LABEL_H = 16;
  g.font = 'bold 12px sans-serif';
  g.textBaseline = 'middle';
  const placed = [];
  const overlaps = (a) => placed.some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
  const fits = (a) => a.x >= 0 && a.y >= 0 && a.x + a.w <= canvas.width && a.y + a.h <= canvas.height;
  for (const m of marks) {
    const x = m.x * sx, y = m.y * sy, w = m.w * sx, h = m.h * sy;
    g.strokeStyle = COLOR;
    g.lineWidth = 2;
    g.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));
    const lw = g.measureText(m.ref).width + 6;
    const tries = [
      { x, y: y - LABEL_H }, { x, y }, { x, y: y + h }, { x: x + w - lw, y: y - LABEL_H },
    ].map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), w: lw, h: LABEL_H }));
    const spot = tries.find((t) => fits(t) && !overlaps(t)) ?? tries.find(fits) ?? tries[1];
    placed.push(spot);
    g.fillStyle = COLOR;
    g.fillRect(spot.x, spot.y, spot.w, spot.h);
    g.fillStyle = '#ffffff';
    g.fillText(m.ref, spot.x + 3, spot.y + LABEL_H / 2 + 1);
  }
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  const out = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
  return btoa(s);
}`;

/**
 * The screenshot with its marks drawn, as base64 JPEG, or null when it could
 * not be drawn — the caller then sends the clean one.
 */
export async function drawMarks(
  cdp: MarkSession,
  image: { data: string; width: number; height: number },
  marks: Mark[],
): Promise<string | null> {
  if (!marks.length) return image.data;
  try {
    const tree = await cdp.send('Page.getFrameTree') as { frameTree?: { frame?: { id?: string } } };
    const frameId = tree?.frameTree?.frame?.id;
    if (!frameId) return null;
    const world = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: WORLD }) as { executionContextId?: number };
    if (typeof world?.executionContextId !== 'number') return null;
    const args = JSON.stringify({ data: image.data, marks, width: image.width, height: image.height });
    const evaluated = await cdp.send('Runtime.evaluate', {
      expression: `(${DRAW})(${args})`,
      contextId: world.executionContextId,
      awaitPromise: true,
      returnByValue: true,
    }) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    const value = evaluated?.result?.value;
    if (evaluated?.exceptionDetails || typeof value !== 'string' || !value) return null;
    return value;
  } catch {
    return null;
  }
}
