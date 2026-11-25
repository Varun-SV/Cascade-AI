// ─────────────────────────────────────────────
//  Cascade AI — Sign in with ChatGPT (ChatGPT plan usage)
// ─────────────────────────────────────────────
//
//  CLI and desktop only. Hosted web apps need OpenAI's commercial partner
//  program, and the flow forbids tokens in browser storage.

export * from './constants.js';
export { ChatGptAuthError, ChatGptRequestError, requestErrorFrom } from './errors.js';
export type { ChatGptAuthErrorKind, ChatGptRequestErrorKind } from './errors.js';
export { ChatGptAuth, chatGptAuth, needsRefresh, EXPORT_FORMAT } from './manager.js';
export type {
  AccessToken, AuthUrlInfo, ChatGptAuthDeps, ChatGptStatus, SignInOptions, SignInResult, SignOutResult,
} from './manager.js';
export { buildAuthorizeUrl, redactAuthorizeUrl } from './oauth.js';
export { openSystemBrowser } from './browser.js';
export { chatGptDir, chatGptPlanReady, readStore, getHostId } from './store.js';
export type { PublicAccount } from './store.js';
