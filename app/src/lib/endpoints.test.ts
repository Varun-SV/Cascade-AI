import { describe, expect, it } from 'vitest';
import { addressableEndpoints } from './endpoints';

describe('addressableEndpoints — a blank field is not a clear until it has loaded', () => {
  const fields = [
    ['anthropic', ''], ['openai', ''], ['gemini', ''],
    ['openai-compatible', ''], ['ollama', ''],
  ] as const;

  it('sends nothing before the snapshot arrives', () => {
    // The reported case: Settings is opened over a config holding
    // `{ anthropic, baseUrl: 'https://corp-gateway', apiKey }`, and the user
    // presses Save — or pastes a rotated gateway key and saves — before the
    // first snapshot lands. Sending `anthropic: undefined` here is an explicit
    // clear, and retires the credential paired with that gateway.
    // Asserted on the KEYS. `toEqual` treats `{ anthropic: undefined }` as
    // equal to `{}`, and those two are the whole distinction here: one is "this
    // surface cannot address that provider", the other is "the user cleared
    // it". A `toEqual` here passed with the rule deleted.
    const sent = addressableEndpoints(fields, { hydrated: false, touched: new Set() });
    expect(Object.keys(sent)).toEqual([]);
  });

  it('sends every field once it has', () => {
    // After hydration a blank field IS a clear, and must be sent as one.
    const sent = addressableEndpoints(
      [['anthropic', ''], ['openai-compatible', 'https://api.groq.com/openai/v1']],
      { hydrated: true, touched: new Set() },
    );
    expect(Object.keys(sent).sort()).toEqual(['anthropic', 'openai-compatible']);
    expect(sent['anthropic']).toBeUndefined();
    expect(sent['openai-compatible']).toBe('https://api.groq.com/openai/v1');
  });

  it('sends a field the user touched even before hydration', () => {
    // They typed it. Withholding their own edit would be its own bug.
    const sent = addressableEndpoints(
      [['anthropic', 'https://gw.example'], ['openai', '']],
      { hydrated: false, touched: new Set(['anthropic']) },
    );
    expect(Object.keys(sent)).toEqual(['anthropic']);
    expect(sent['anthropic']).toBe('https://gw.example');
  });

  it('treats a field cleared by hand as the clear it is', () => {
    const sent = addressableEndpoints(
      [['anthropic', '   ']],
      { hydrated: false, touched: new Set(['anthropic']) },
    );
    expect(Object.keys(sent)).toEqual(['anthropic']);
    expect(sent['anthropic']).toBeUndefined();
  });

  it('trims, so whitespace is never stored as a host', () => {
    expect(addressableEndpoints(
      [['anthropic', '  https://gw.example  ']],
      { hydrated: true, touched: new Set() },
    )).toEqual({ anthropic: 'https://gw.example' });
  });
});
