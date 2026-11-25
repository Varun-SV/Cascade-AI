// ─────────────────────────────────────────────
//  Cascade AI — Sign in with ChatGPT: constants
// ─────────────────────────────────────────────
//
//  ChatGPT plan usage through OpenAI's official open-source flow
//  (https://developers.openai.com/siwc/token-sharing-open-source). Not the
//  Codex CLI's client and not ~/.codex/auth.json: Cascade registers its own
//  dynamic client and keeps its own credential file.

export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_DISCOVERY_URL = `${CHATGPT_ISSUER}/.well-known/openid-configuration`;
export const CHATGPT_AUTHORIZE_URL = `${CHATGPT_ISSUER}/api/accounts/authorize`;
export const CHATGPT_TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;

/** The audience of the access token and the base URL of every inference request. */
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';

/** First-time registration entrypoint. Never saved, never used to exchange a code. */
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
/** Display name for the registration; used consistently, and only on first registration. */
export const AGENT_NAME_HINT = 'Cascade';

export const PLAN_USAGE_SCOPE = 'chatgpt.tokens.use.direct';
export const CHATGPT_SCOPES = [
  'openid', 'profile', 'email',
  'offline_access', 'resource.invoke', PLAN_USAGE_SCOPE,
] as const;

/** Tried first; any free port after that. Only the port may vary. */
export const PREFERRED_CALLBACK_PORT = 1455;
export const CALLBACK_PATH = '/auth/callback';
export const CALLBACK_HOST = '127.0.0.1';

export const MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';

export const ACCOUNTS_FILE = 'chatgpt-accounts.json';
export const HOST_ID_FILE = 'chatgpt-host.json';

/** Shown once, after the first successful sign-in (UI/UX guidelines). */
export const WELCOME_TITLE = "You're using your ChatGPT plan";
export const WELCOME_BODY =
  'Eligible usage in Cascade uses your ChatGPT plan. Manage usage in your ChatGPT settings.';
export const WELCOME_CLI =
  "You're using your ChatGPT plan. Eligible usage in Cascade uses your ChatGPT plan. Manage usage in your ChatGPT settings.";
export const USING_PLAN_LABEL = 'Using ChatGPT plan';
export const USAGE_LIMIT_MESSAGE = "Review your plan or this app's limit in ChatGPT settings.";

/** Refresh when the access token has this long left (and the server allows it). */
export const REFRESH_SKEW_MS = 5 * 60_000;
/** Below this the token is treated as expired whatever `earliest_refresh_at` says. */
export const EXPIRY_FLOOR_MS = 30_000;
