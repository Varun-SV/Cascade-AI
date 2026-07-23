// A provider's model-list endpoint returns *every* model it hosts — including
// ones that can't produce a text chat reply: embeddings, text-to-speech and
// speech-to-text, image/video generation, moderation/safety classifiers,
// rerankers, realtime/audio and legacy completion-only base models. Routing a
// normal turn to one of those fails (e.g. Gemini's TTS models only accept AUDIO
// output; OpenAI's `tts-1`/`text-embedding-*` aren't chat models). So every
// provider filters its discovered models through `isChatModel` before they can
// enter the router's candidate pool.

// Matched case-insensitively against the model id. Token-boundary anchors keep
// it from clipping legitimate chat models (e.g. `-image-` is excluded but
// `imagen` is listed explicitly; `vision` is deliberately NOT here — vision
// chat models produce text).
const NON_CHAT_PATTERNS = [
  'embed', // text-embedding-3, nomic-embed, mxbai-embed, snowflake-arctic-embed
  '(?:^|[-_/])tts(?:[-_/]|$)', 'text-to-speech', 'speech', // text-to-speech
  'whisper', 'transcrib', '(?:^|[-_/])stt(?:[-_/]|$)', // speech-to-text
  'dall[-]?e', 'imagen', 'image-generation', 'gpt-image',
  '(?:^|[-_/])image(?:[-_/]|$)', 'stable-diffusion', 'sdxl', 'flux', // image gen
  'moderation', '(?:^|[-_/])guard(?:[-_/]|$)', // moderation / safety
  'rerank',
  '(?:^|[-_/])audio(?:[-_/]|$)', 'native-audio', 'realtime', // audio / realtime
  'veo', 'sora', '(?:^|[-_/])video(?:[-_/]|$)', // video
  '(?:^|[-_/])aqa(?:[-_/]|$)', // attributed QA
  '(?:^|[-_/])live(?:[-_/]|$)', // live-audio variants
  '(?:^|[-_/])(?:davinci|babbage)(?:[-_/]|$)', // legacy completion-only base models
];
const NON_CHAT = new RegExp(NON_CHAT_PATTERNS.join('|'), 'i');

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
