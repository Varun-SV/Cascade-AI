import { describe, expect, it } from 'vitest';
import { addressableEndpoints, hydrateEndpoints } from './endpoints';

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

describe('hydrateEndpoints — a late snapshot does not overwrite an edit', () => {
  const current = { anthropic: '', 'openai-compatible': '' };

  it('fills untouched fields from the snapshot', () => {
    expect(hydrateEndpoints(current, { anthropic: 'https://gw.example' }, new Set()))
      .toEqual({ anthropic: 'https://gw.example', 'openai-compatible': '' });
  });

  it('leaves a field the user has already typed in', () => {
    // The race: the user types gateway B, the snapshot lands holding gateway A,
    // and overwriting loses the edit — while the key they typed for B stays in
    // the form and the next save pairs it with A.
    expect(hydrateEndpoints(
      { anthropic: 'https://gateway-b.example' },
      { anthropic: 'https://gateway-a.example' },
      new Set(['anthropic']),
    )).toEqual({ anthropic: 'https://gateway-b.example' });
  });

  it('leaves a field the user deliberately emptied', () => {
    expect(hydrateEndpoints(
      { anthropic: '' },
      { anthropic: 'https://gateway-a.example' },
      new Set(['anthropic']),
    )).toEqual({ anthropic: '' });
  });

  it('clears an untouched field the snapshot no longer names', () => {
    expect(hydrateEndpoints({ anthropic: 'stale' }, {}, new Set()))
      .toEqual({ anthropic: '' });
  });

  it('changes nothing when there is no snapshot to apply', () => {
    expect(hydrateEndpoints({ anthropic: 'typed' }, undefined, new Set()))
      .toEqual({ anthropic: 'typed' });
  });
});

describe('the edit → late snapshot → save transition, end to end', () => {
  // The wiring bug the unit tests above could not see, because they build
  // `touched` by hand: the inputs called the raw setters, so nothing was ever
  // marked dirty and a pre-hydration edit was dropped from the payload.
  it('sends a gateway typed before hydration, and keeps it across the snapshot', () => {
    const touched = new Set<string>();
    // 1. The user types a gateway before anything has loaded. The input marks
    //    the field dirty — that is the step that was missing.
    touched.add('anthropic');
    const typed = { anthropic: 'https://gateway-b.example', 'openai-compatible': '' };

    // 2. The snapshot arrives late, holding the OLD host.
    const afterSnapshot = hydrateEndpoints(
      typed,
      { anthropic: 'https://gateway-a.example', 'openai-compatible': 'https://api.groq.com/openai/v1' },
      touched,
    );
    expect(afterSnapshot['anthropic']).toBe('https://gateway-b.example');
    // …and the field they never touched IS filled from it.
    expect(afterSnapshot['openai-compatible']).toBe('https://api.groq.com/openai/v1');

    // 3. Saving sends the edit, even though hydration had not completed when
    //    they typed it.
    const sent = addressableEndpoints(
      [['anthropic', afterSnapshot['anthropic'] ?? ''], ['openai-compatible', afterSnapshot['openai-compatible'] ?? '']],
      { hydrated: false, touched },
    );
    expect(Object.keys(sent)).toEqual(['anthropic']);
    expect(sent['anthropic']).toBe('https://gateway-b.example');
  });
});
