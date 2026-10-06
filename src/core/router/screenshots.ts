// ─────────────────────────────────────────────
//  Cascade AI — Which models a browser screenshot may reach
// ─────────────────────────────────────────────
//
//  A worker driving a browser can attach a screenshot of the page to its next
//  request (see T3Worker). Whether it actually goes is decided HERE, against
//  the model the router finally resolved — not the one the worker planned
//  for. Failover, a transient backoff and the local-only swap can all change
//  the model after the worker built its request, and a picture sent to a
//  model that cannot see it is at best ignored and at worst an error.
//
//  A screenshot is left out, and the model told so in its place, when:
//
//    - the model is not known to read images, or its provider's vision flag
//      cannot be trusted (OpenAI-compatible endpoints report none; a local
//      model gets no screenshots in this version);
//    - one image would cost this model more than the budget check reserves for
//      an image. Prices per image differ by an order of magnitude between
//      models — gpt-4o-mini bills a 1280×800 page at about 37k tokens, where
//      Claude bills about 1.4k — so the reservation alone cannot be trusted
//      to cover it.
//
//  Only screenshots are ever dropped. A picture a person attached is theirs to
//  send, and has its own route (`requireVision`).

import type { GenerateOptions, ImageAttachment, MessageContent, ModelInfo } from '../../types.js';

/** Providers whose vision flag reflects the model, and whose image price is known. */
const PRICED_VISION = new Set(['anthropic', 'openai', 'azure', 'gemini']);

/**
 * OpenAI models priced by 32px patch, and the multiplier they bill patches at.
 * The rest of the family is priced by 512px tile.
 */
const PATCH_PRICED: Array<[RegExp, number]> = [
  [/gpt-4\.1-mini/, 1.62],
  [/gpt-4\.1-nano/, 2.46],
  [/o4-mini/, 1.72],
  [/gpt-5(?:\.\d+)?-mini/, 1.62],
  [/gpt-5(?:\.\d+)?-nano/, 2.46],
];

/**
 * Tokens one screenshot of `width`×`height` CSS pixels costs `model`, or null
 * when that cannot be said — which keeps the screenshot out.
 *
 * Each provider's published rule, including the downscaling it does first.
 */
export function screenshotTokens(model: ModelInfo, width: number, height: number): number | null {
  if (!(width > 0 && height > 0)) return null;
  const id = (model.baseModelId ?? model.id).toLowerCase();
  switch (model.provider) {
    case 'anthropic': {
      // Long edge to 1568px, then to about 1.15 megapixels; ~750 px a token.
      const scale = Math.min(1, 1568 / Math.max(width, height), Math.sqrt(1_150_000 / (width * height)));
      return Math.ceil((width * scale * height * scale) / 750);
    }
    case 'gemini': {
      // 258 for a small image; otherwise 258 a 768px tile.
      if (width <= 384 && height <= 384) return 258;
      return Math.ceil(width / 768) * Math.ceil(height / 768) * 258;
    }
    case 'openai':
    case 'azure': {
      const patch = PATCH_PRICED.find(([re]) => re.test(id));
      if (patch) {
        // 32px patches, scaled down to at most 1,536 of them.
        const raw = Math.ceil(width / 32) * Math.ceil(height / 32);
        const patches = Math.min(raw, 1536);
        return Math.ceil(patches * patch[1]);
      }
      if (/mini|nano/.test(id) && !/gpt-4o-mini/.test(id)) {
        // An unlisted small model: priced at the steepest patch rate known.
        return Math.ceil(Math.min(Math.ceil(width / 32) * Math.ceil(height / 32), 1536) * 2.46);
      }
      // High detail: fit in 2048², shortest side to 768, then 512px tiles.
      let w = width;
      let h = height;
      const fit = Math.min(1, 2048 / Math.max(w, h));
      w *= fit; h *= fit;
      const short = Math.min(w, h);
      if (short > 768) { w *= 768 / short; h *= 768 / short; }
      const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
      // gpt-4o-mini bills images at ~33× the tokens, to keep the same price.
      return /gpt-4o-mini/.test(id) ? 2833 + 5667 * tiles : 85 + 170 * tiles;
    }
    default:
      return null;
  }
}

/**
 * Whether `model` can take a typical page screenshot (1280×800) at all — the
 * worker's question, asked so it does not have one taken for nothing. The
 * router still decides per request, against the model it resolves.
 */
export function mayTakeScreenshots(model: ModelInfo | undefined, ceiling: number): boolean {
  if (!model) return false;
  return screenshotRefusal(model, { type: 'base64', data: '', mimeType: 'image/jpeg', screenshot: { width: 1280, height: 800 } }, ceiling) === null;
}

/** Why a screenshot may not go to this model, or null when it may. */
export function screenshotRefusal(model: ModelInfo, image: ImageAttachment, ceiling: number): string | null {
  if (!model.isVisionCapable || !PRICED_VISION.has(model.provider) || model.isLocal) {
    return 'Screenshot left out: this model cannot view images. Use the page view.';
  }
  const size = image.screenshot;
  const tokens = size ? screenshotTokens(model, size.width, size.height) : null;
  if (tokens === null || tokens > ceiling) {
    return 'Screenshot left out: on this model one would cost more than a run allows for an image. Use the page view.';
  }
  return null;
}

/**
 * The request as `model` may receive it: every screenshot it cannot take
 * replaced by a line saying why. The same object when nothing changed.
 */
export function fitScreenshots(options: GenerateOptions, model: ModelInfo, ceiling: number): GenerateOptions {
  let changed = false;
  const messages = options.messages.map((m) => {
    if (typeof m.content === 'string' || !m.content.some((b) => b.type === 'image' && b.image.screenshot)) return m;
    const content = m.content.map((block): MessageContent => {
      if (block.type !== 'image' || !block.image.screenshot) return block;
      const refusal = screenshotRefusal(model, block.image, ceiling);
      if (!refusal) return block;
      changed = true;
      return { type: 'text', text: `[${refusal}]` };
    });
    return { ...m, content };
  });
  return changed ? { ...options, messages } : options;
}

/** Screenshots in a request. */
export function countScreenshots(options: GenerateOptions): number {
  let n = 0;
  for (const m of options.messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) if (b.type === 'image' && b.image.screenshot) n++;
  }
  return n;
}
