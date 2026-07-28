// A provider's model-list endpoint returns *every* model it hosts — including
// ones that can't produce a text chat reply: embeddings, text-to-speech and
// speech-to-text, image/video generation, moderation/safety classifiers,
// rerankers, realtime/audio and legacy completion-only base models. Routing a
// normal turn to one of those fails (e.g. Gemini's TTS models only accept AUDIO
// output; OpenAI's `tts-1`/`text-embedding-*` aren't chat models). So every
// provider filters its discovered models through `isChatModel` before they can
// enter the router's candidate pool.
//
// Those models are not junk, though — they are the ones that draw the picture,
// read the audio, speak the answer. Dropping them from the CHAT pool and
// forgetting they exist is what left Cascade unable to generate an image with
// an image model sitting right there in the account. So the patterns below are
// grouped BY MODALITY rather than lumped into one reject-list, and
// `classifyModality` hands the non-chat ones to the multimodal registry
// (core/multimodal/registry.ts) instead of throwing them away.

/** What a model produces. 'chat' is the text pool; everything else is a tool. */
export type Modality =
  | 'chat'
  | 'embedding'
  | 'image'
  | 'video'
  | 'speech'          // text → audio (TTS)
  | 'transcription'   // audio → text (STT)
  | 'moderation'
  | 'rerank'
  | 'realtime'
  | 'legacy-completion';

// Order matters: the first group whose pattern matches wins, so the more
// specific families come first. `vision` is deliberately absent throughout —
// a vision-capable chat model produces text and belongs in the chat pool.
const MODALITY_PATTERNS: ReadonlyArray<readonly [Exclude<Modality, 'chat'>, readonly string[]]> = [
  ['embedding', ['embed']], // text-embedding-3, nomic-embed, mxbai-embed, snowflake-arctic-embed
  ['transcription', ['whisper', 'transcrib', '(?:^|[-_/])stt(?:[-_/]|$)']],
  ['speech', ['(?:^|[-_/])tts(?:[-_/]|$)', 'text-to-speech', 'speech']],
  ['video', ['veo', 'sora', '(?:^|[-_/])video(?:[-_/]|$)']],
  ['image', [
    'dall[-]?e', 'imagen', 'image-generation', 'gpt-image',
    '(?:^|[-_/])image(?:[-_/]|$)', 'stable-diffusion', 'sdxl', 'flux',
  ]],
  ['moderation', ['moderation', '(?:^|[-_/])guard(?:[-_/]|$)']],
  ['rerank', ['rerank']],
  ['realtime', [
    '(?:^|[-_/])audio(?:[-_/]|$)', 'native-audio', 'realtime',
    '(?:^|[-_/])live(?:[-_/]|$)', // live-audio variants
    '(?:^|[-_/])aqa(?:[-_/]|$)',  // attributed QA
  ]],
  ['legacy-completion', ['(?:^|[-_/])(?:davinci|babbage)(?:[-_/]|$)']],
];

const MODALITY_REGEXES: ReadonlyArray<readonly [Exclude<Modality, 'chat'>, RegExp]> =
  MODALITY_PATTERNS.map(([m, pats]) => [m, new RegExp(pats.join('|'), 'i')] as const);

// Kept as one combined test so `isChatModel` behaves exactly as it did before
// this file grew a classifier — the chat pool must not change shape.
const NON_CHAT = new RegExp(MODALITY_PATTERNS.flatMap(([, p]) => p).join('|'), 'i');

/**
 * What this model produces, by id.
 *
 * Returns 'chat' for anything that doesn't match a known non-chat family —
 * the same default `isChatModel` uses, and the safe one: a misclassified chat
 * model still works, while a chat model wrongly filed as an image generator
 * would vanish from routing entirely.
 */
export function classifyModality(id: string, methods?: string[]): Modality {
  if (methods && methods.length > 0) {
    // Gemini reports what a model can actually be called with, which beats any
    // guess from the name.
    if (methods.some((m) => /embedcontent/i.test(m))) return 'embedding';
    if (methods.some((m) => /predictlongrunning/i.test(m))) return 'video';
    if (methods.some((m) => /^predict$/i.test(m))) return 'image';
  }
  for (const [modality, re] of MODALITY_REGEXES) {
    if (re.test(id)) return modality;
  }
  return 'chat';
}

/**
 * True when a model id looks like a general text-chat model. `methods`, when a
 * provider reports it (Gemini's `supportedGenerationMethods`), is authoritative:
 * a model that can't `generateContent` (e.g. an embedder) is dropped outright.
 * Otherwise the decision is by id pattern.
 */
export function isChatModel(id: string, methods?: string[]): boolean {
  if (methods && methods.length > 0) {
    const canGenerate = methods.some((m) => /generatecontent|generatemessage|chat|completion/i.test(m));
    if (!canGenerate) return false;
  }
  return !NON_CHAT.test(id);
}
