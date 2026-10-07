// ─────────────────────────────────────────────
//  Cascade AI — Which endpoint serves a model, and whether it is private
// ─────────────────────────────────────────────

import { OLLAMA_BASE_URL } from '../../constants.js';
import type { ModelInfo, ProviderConfig } from '../../types.js';
import { isLoopbackOrPrivateHost } from './pricing.js';

/**
 * The provider config a model's calls go through. Azure has one per
 * deployment — the model's id is the deployment name, and binding the first
 * would send every deployment to one resource — and every other provider
 * serves all its models through the first config of its type.
 */
export function providerConfigFor(model: ModelInfo, configs: ProviderConfig[]): ProviderConfig {
  return (model.provider === 'azure'
    ? configs.find((c) => c.type === 'azure' && c.deploymentName === model.id)
    : undefined)
    ?? configs.find((c) => c.type === model.provider)
    ?? { type: model.provider };
}

/**
 * Whether a call to `model` stays on this machine or a private network: the
 * endpoint serving it is loopback, a private range or a `.local` host. Read
 * from that endpoint, never from `ModelInfo.isLocal`: that says the model
 * costs $0, which a hosted server can be configured to claim (`local: true`),
 * and which an Ollama pointed at someone else's box claims by default.
 */
export function isPrivateEndpoint(model: ModelInfo, configs: ProviderConfig[]): boolean {
  if (model.provider !== 'ollama' && model.provider !== 'openai-compatible') return false;
  const cfg = providerConfigFor(model, configs);
  // An address the name alone cannot prove private — a bare LAN name like
  // `ollama` in a compose file, or one a private DNS zone serves — is
  // declared so by the user.
  if (cfg.privateNetwork === true) return true;
  return isLoopbackOrPrivateHost(cfg.baseUrl ?? (model.provider === 'ollama' ? OLLAMA_BASE_URL : undefined));
}
