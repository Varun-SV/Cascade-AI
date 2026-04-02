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
    return (
      (inputTokens / 1000) * this.model.inputCostPer1kTokens +
      (outputTokens / 1000) * this.model.outputCostPer1kTokens
    );
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
