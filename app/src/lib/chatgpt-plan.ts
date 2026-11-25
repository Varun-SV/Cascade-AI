// ChatGPT plan usage in the window (Sign in with ChatGPT). The window only ever
// sees an account's email and state; the main process holds every token
// (app/electron/chatgpt-plan.ts).

export const MANAGE_USAGE_LABEL = 'Manage usage';
export const WELCOME_TITLE = "You're using your ChatGPT plan";
export const WELCOME_BODY = 'Eligible usage in Cascade uses your ChatGPT plan. Manage usage in your ChatGPT settings.';
export const USING_PLAN_LABEL = 'Using ChatGPT plan';
export const LIMIT_TITLE = 'Usage limit reached';
export const LIMIT_BODY = "Review your plan or this app's limit in ChatGPT settings.";

export interface PlanAccountView {
  id: string; email: string; label: string; active: boolean; signedIn: boolean;
  planUsageEnabled: boolean; needsSignIn: boolean; accessTokenExpiresAt?: string;
}
export interface PlanViewState {
  accounts: PlanAccountView[]; active: PlanAccountView | null; planReady: boolean;
  welcomePending: boolean; signingIn: boolean; manageUsageUrl: string;
}

/** A model the signed-in ChatGPT plan serves (the router names them `chatgpt:<slug>`). */
export const isPlanModel = (id: string | undefined): boolean => typeof id === 'string' && id.startsWith('chatgpt:');

/**
 * Whether the composer says "Using ChatGPT plan": the chosen model is one of the
 * plan's, or the model is Auto and the plan is the only provider with a way to pay.
 */
export function usingPlan(model: string | undefined, planReady: boolean, otherProviders: number): boolean {
  if (!planReady) return false;
  if (isPlanModel(model)) return true;
  return (!model || model === 'auto') && otherProviders === 0;
}

/** A failed run's message that is the plan's usage limit (its text carries the code or the usage page). */
export function isUsageLimitMessage(text: string | undefined | null): boolean {
  return typeof text === 'string'
    && (/subscription_sharing_usage_limit_exceeded/.test(text) || /ChatGPT plan usage limit reached/i.test(text));
}
