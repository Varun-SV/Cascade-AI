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
//    - the model is reached through a gateway rather than its provider's own
//      endpoint: what the gateway lists as a vision model is its own claim;
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
 * Auto-detail patch rules: model, multiplier, patch budget and longest edge.
 * https://developers.openai.com/api/docs/guides/images-vision (2026-10-18).
 * Unlisted model variants are not assumed to inherit a different model's rate.
 */
const PATCH_PRICED: Array<[RegExp, number, number, number]> = [
  [/^gpt-6-astra(?:-\d{4}-\d{2}-\d{2})?$/, 1.2, Infinity, 65_535],
  [/^gpt-5\.6-(?:sol|terra|luna)(?:-\d{4}-\d{2}-\d{2})?$/, 1.2, Infinity, 65_535],
  [/^gpt-5\.5(?:-\d{4}-\d{2}-\d{2})?$/, 1.2, 10_000, 6000],
  [/^gpt-5\.4(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/, 1.2, 2500, 2048],
  [/^gpt-5\.2(?:-\d{4}-\d{2}-\d{2})?$/, 1.2, 6144, 2048],
  [/^gpt-4\.1-mini(?:-\d{4}-\d{2}-\d{2})?$/, 1.62, 6144, 2048],
  [/^gpt-4\.1-nano(?:-\d{4}-\d{2}-\d{2})?$/, 2.46, 1536, Infinity],
  [/^o4-mini(?:-\d{4}-\d{2}-\d{2})?$/, 1.72, 1536, Infinity],
  [/^gpt-5-mini(?:-\d{4}-\d{2}-\d{2})?$/, 1.2, 1536, Infinity],
  [/^gpt-5-nano(?:-\d{4}-\d{2}-\d{2})?$/, 1.5, 1536, Infinity],
];

/**
 * Tokens one screenshot of `width`×`height` CSS pixels costs `model`, or null
 * when that cannot be said — which keeps the screenshot out.
 *
 * Each provider's published rule, including the downscaling it does first.
 */
export function screenshotTokens(model: ModelInfo, width: number, height: number): number | null {
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) return null;
  const id = (model.baseModelId ?? model.id).toLowerCase().replace(/^openai\//, '');
  switch (model.provider) {
    case 'anthropic': {
      // ~750 px a token, after downscaling. Priced at the high-resolution
      // limits (Opus 4.7 and later, Sonnet 5 and later): long edge to 2576px,
      // then to about 3.75 megapixels, at most 4,784 tokens. Older models stop
      // at 1568px and 1.15 megapixels, so this can only overstate their price
      // — which keeps a screenshot out, never lets one in.
      const scale = Math.min(1, 2576 / Math.max(width, height), Math.sqrt(3_750_000 / (width * height)));
      return Math.min(4784, Math.ceil((width * scale * height * scale) / 750));
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
        const scale = Math.min(1, patch[3] / Math.max(width, height));
        const raw = Math.ceil(Math.max(1, Math.ceil(width * scale)) / 32)
          * Math.ceil(Math.max(1, Math.ceil(height * scale)) / 32);
        // Budget is a conservative upper bound after proportional resizing;
        // integer patch alignment can reduce the actual bill below this cap.
        const patches = Math.min(raw, patch[2]);
        if (!Number.isFinite(patches) || patches > 30_000) return null;
        return Math.ceil(patches * patch[1]);
      }
      const tile = /^(?:gpt-4o-mini)(?:-\d{4}-\d{2}-\d{2})?$/.test(id) ? [2833, 5667]
        : /^(?:gpt-4o|gpt-4\.1)(?:-\d{4}-\d{2}-\d{2})?$/.test(id) ? [85, 170]
          : /^gpt-5(?:\.1)?(?:-\d{4}-\d{2}-\d{2})?$/.test(id) ? [70, 140]
            : /^(?:o1|o1-pro|o3)(?:-\d{4}-\d{2}-\d{2})?$/.test(id) ? [75, 150] : null;
      if (!tile) return null;
      // High detail: fit in 2048², shortest side to 768, then 512px tiles.
      let w = width;
      let h = height;
      const fit = Math.min(1, 2048 / Math.max(w, h));
      w *= fit; h *= fit;
      const short = Math.min(w, h);
      if (short > 768) { w *= 768 / short; h *= 768 / short; }
      const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
      // gpt-4o-mini bills images at ~33× the tokens, to keep the same price.
      return tile[0]! + tile[1]! * tiles;
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
export function mayTakeScreenshots(model: ModelInfo | undefined, ceiling: number, route: ScreenshotRoute = {}): boolean {
  if (!model) return false;
  return screenshotRefusal(model, { type: 'base64', data: '', mimeType: 'image/jpeg', screenshot: { width: 1280, height: 800 } }, ceiling, route) === null;
}

/** How `model` is reached, where that bears on whether it may get a screenshot. */
export interface ScreenshotRoute {
  /** Through an endpoint other than the provider's own. See `screenshotRefusal`. */
  gateway?: boolean;
}

/** Why a screenshot may not go to this model, or null when it may. */
export function screenshotRefusal(
  model: ModelInfo,
  image: ImageAttachment,
  ceiling: number,
  route: ScreenshotRoute = {},
): string | null {
  if (!model.isVisionCapable || !PRICED_VISION.has(model.provider) || model.isLocal) {
    return 'Screenshot left out: this model cannot view images. Use the page view.';
  }
  if (route.gateway) {
    return 'Screenshot left out: this model is reached through a gateway, so whether it can view images, and at what price, cannot be checked. Use the page view.';
  }
  const size = image.screenshot;
  const tokens = size ? screenshotTokens(model, size.width, size.height) : null;
  // Written so that a price that is not a number keeps the screenshot out.
  if (tokens === null || !(tokens <= ceiling)) {
    return 'Screenshot left out: on this model one would cost more than a run allows for an image. Use the page view.';
  }
  return null;
}

/**
 * The request as `model` may receive it: every screenshot it cannot take
 * replaced by a line saying why. The same object when nothing changed.
 */
export function fitScreenshots(
  options: GenerateOptions,
  model: ModelInfo,
  ceiling: number,
  route: ScreenshotRoute = {},
): GenerateOptions {
  let changed = false;
  const messages = options.messages.map((m) => {
    if (typeof m.content === 'string' || !m.content.some((b) => b.type === 'image' && b.image.screenshot)) return m;
    const content = m.content.map((block): MessageContent => {
      if (block.type !== 'image' || !block.image.screenshot) return block;
      const refusal = screenshotRefusal(model, block.image, ceiling, route);
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
