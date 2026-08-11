// ─────────────────────────────────────────────
//  Cascade AI — Abstract Provider Base
// ─────────────────────────────────────────────

import type {
  GenerateOptions,
  GenerateResult,
  ModelInfo,
  ProviderConfig,
  StreamChunk,
  TokenUsage,
} from '../types.js';
import { buildTokenUsage, calculateCost } from '../utils/cost.js';

/**
 * A probe failure that says nothing about the credentials — a rate limit, a
 * 5xx, a DNS blip, a connection reset.
 *
 * The distinction matters twice over. It decides what the user is told: "your
 * key was rejected" sends someone to regenerate a key that is perfectly good
 * when the real answer was that the service was briefly down. And it decides
 * whether the provider survives startup at all — a transient blip must not
 * erase a user's only provider for the rest of the session, which is the same
 * reasoning already written out for Azure deployments and openai-compatible
 * endpoints in the router. Those stay usable and fail loudly at generate time
 * with the provider's own concrete error, which is far more actionable than a
 * blanket "no model available".
 */
export class ProviderUnreachableError extends Error {
  readonly transient = true;
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnreachableError';
  }
}

export abstract class BaseProvider {
  protected config: ProviderConfig;
  protected model: ModelInfo;

  constructor(config: ProviderConfig, model: ModelInfo) {
    this.config = config;
    this.model = model;
  }

  abstract generate(options: GenerateOptions): Promise<GenerateResult>;

  abstract generateStream(
    options: GenerateOptions,
    onChunk: (chunk: StreamChunk) => void,
  ): Promise<GenerateResult>;

  abstract countTokens(text: string): Promise<number>;

  abstract listModels(): Promise<ModelInfo[]>;

  abstract isAvailable(): Promise<boolean>;

  getModel(): ModelInfo {
    return this.model;
  }

  isVisionCapable(): boolean {
    return this.model.isVisionCapable;
  }

  estimateCost(inputTokens: number, outputTokens: number): number {
    // Delegate to the shared calculator, which falls back to the bundled
    // catalogue pricing by model id when this.model has none (the cause of the
    // $0.00 cost readout for configured per-tier overrides).
    return calculateCost(inputTokens, outputTokens, this.model);
  }

  protected makeUsage(inputTokens: number, outputTokens: number): TokenUsage {
    // buildTokenUsage also flags `costUnknown` when we have no price for this
    // model, so a $0 total is never mistaken downstream for a free call.
    return buildTokenUsage(inputTokens, outputTokens, this.model);
  }
}
