// ─────────────────────────────────────────────
//  Cascade AI — Model Profiler
// ─────────────────────────────────────────────
//
//  Discovers model specializations at first run.
//  Strategy: OpenRouter public API first (no auth, free), then direct LLM query as fallback.
//  Results are cached in SQLite so profiling runs at most once per model.
//

import type { ModelInfo, ProviderType } from '../../types.js';
import type { MemoryStore } from '../../memory/store.js';
import type { CascadeRouter } from './index.js';

// Models to skip — no specialization query makes sense for these
const SKIP_PATTERN = /embed|dall-e|whisper|tts|vision|instruct-vision|rerank/i;

interface OpenRouterModel {
  id: string;
  description?: string;
  name?: string;
}

const SPECIALIZATION_KEYWORDS: Record<string, string[]> = {
  code: ['code', 'coding', 'programming', 'developer', 'software', 'function', 'debug', 'typescript', 'python', 'javascript'],
  analysis: ['analysis', 'analytical', 'reasoning', 'logic', 'research', 'evaluate', 'assess', 'explain'],
  creative: ['creative', 'writing', 'story', 'poetry', 'content', 'blog', 'essay', 'narrative'],
  data: ['data', 'sql', 'statistics', 'chart', 'csv', 'json', 'excel', 'spreadsheet', 'math', 'mathematical'],
  instruction: ['instruction', 'instruction-following', 'accurate', 'precise', 'factual'],
  multilingual: ['multilingual', 'language', 'translation', 'linguistic'],
  long_context: ['long', 'context', 'document', 'book', 'summarize', 'large'],
};

function extractSpecializations(description: string): string[] {
  const lower = description.toLowerCase();
  const found: string[] = [];
  for (const [key, terms] of Object.entries(SPECIALIZATION_KEYWORDS)) {
    if (terms.some(t => lower.includes(t))) {
      found.push(key);
    }
  }
  return found;
}

async function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'User-Agent': 'Cascade-AI/0.4.0' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return [];
    const data = await resp.json() as { data?: OpenRouterModel[] };
    return data.data ?? [];
  } catch {
    return [];
  }
}

async function queryModelDirectly(router: CascadeRouter, model: ModelInfo): Promise<string[]> {
  try {
    const result = await router.generate('T3', {
      messages: [{
        role: 'user',
        content: 'What are your top 3 task specializations? Reply with valid JSON only: {"specializations": ["<area1>", "<area2>", "<area3>"]}',
      }],
      maxTokens: 60,
    });
    const match = /\{[\s\S]*?\}/.exec(result.content);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { specializations?: unknown[] };
    const specs = parsed.specializations;
    if (!Array.isArray(specs)) return [];
    return specs.filter((s): s is string => typeof s === 'string').slice(0, 5);
  } catch {
    return [];
  }
}

export class ModelProfiler {
  private store: MemoryStore;
  private router?: CascadeRouter;

  constructor(store: MemoryStore, router?: CascadeRouter) {
    this.store = store;
    this.router = router;
  }

  /**
   * Profile all models that haven't been profiled yet.
   * Safe to call concurrently — SQLite upsert handles races.
   */
  async profileAll(models: ModelInfo[]): Promise<void> {
    const alreadyProfiled = new Set(this.store.getProfiledModelIds());
    const toProfile = models.filter(
      m => !alreadyProfiled.has(m.id) && !SKIP_PATTERN.test(m.id) && !SKIP_PATTERN.test(m.name),
    );
    if (toProfile.length === 0) return;

    // Fetch OpenRouter catalog once
    const openRouterModels = await fetchOpenRouterModels();
    const orByNormalizedId = new Map<string, OpenRouterModel>();
    for (const m of openRouterModels) {
      orByNormalizedId.set(m.id.toLowerCase(), m);
      // Also index by just the model name after the last '/'
      const short = m.id.split('/').pop();
      if (short) orByNormalizedId.set(short.toLowerCase(), m);
    }

    await Promise.allSettled(
      toProfile.map(async (model) => {
        let specializations: string[] = [];

        // Try OpenRouter first
        const orMatch = orByNormalizedId.get(model.id.toLowerCase())
          ?? orByNormalizedId.get(model.id.split('/').pop()?.toLowerCase() ?? '');
        if (orMatch?.description) {
          specializations = extractSpecializations(orMatch.description);
        }

        // Fall back to direct LLM query if no data found
        if (specializations.length === 0 && this.router) {
          specializations = await queryModelDirectly(this.router, model);
        }

        // Store even if empty so we don't re-attempt
        this.store.saveModelProfile(model.id, model.provider as ProviderType, specializations);
      }),
    );
  }
}
