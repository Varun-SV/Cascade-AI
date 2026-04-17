import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicProvider } from './anthropic.js';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

afterEach(() => {
  fetchSpy.mockReset();
});

function makeProvider(): AnthropicProvider {
  return new AnthropicProvider({ type: 'anthropic', apiKey: 'test-key' });
}

describe('AnthropicProvider.listModels', () => {
  it('falls back to the hardcoded catalog on HTTP 401', async () => {
    fetchSpy.mockResolvedValue(
      new Response('{"type":"error"}', { status: 401 }),
    );
    const provider = makeProvider();
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === 'anthropic')).toBe(true);
  });

  it('falls back when the API returns a non-array data field', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: null }), { status: 200 }),
    );
    const provider = makeProvider();
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
  });

  it('falls back when fetch rejects (DNS / offline)', async () => {
    fetchSpy.mockRejectedValue(new Error('ENOTFOUND'));
    const provider = makeProvider();
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
  });

  it('returns parsed models when the API is healthy', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'claude-unknown-model', display_name: 'Unknown' }],
        }),
        { status: 200 },
      ),
    );
    const provider = makeProvider();
    const models = await provider.listModels();
    expect(models.find((m) => m.id === 'claude-unknown-model')).toBeTruthy();
  });
});
