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
import { calculateCost } from '../utils/cost.js';

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
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: this.estimateCost(inputTokens, outputTokens),
    };
  }
}
