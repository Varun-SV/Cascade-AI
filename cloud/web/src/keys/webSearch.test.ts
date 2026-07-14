import { describe, it, expect } from 'vitest';
import { webSearchPayload } from './webSearch.js';

describe('webSearchPayload', () => {
  it('returns undefined when nothing usable is configured', () => {
    expect(webSearchPayload(null)).toBeUndefined();
    expect(webSearchPayload({ backend: 'brave' })).toBeUndefined();
    expect(webSearchPayload({ backend: 'brave', braveApiKey: '   ' })).toBeUndefined();
  });

  it('emits only the field matching the selected backend', () => {
    expect(webSearchPayload({ backend: 'brave', braveApiKey: 'b', tavilyApiKey: 't' })).toEqual({ braveApiKey: 'b' });
    expect(webSearchPayload({ backend: 'tavily', tavilyApiKey: 't', braveApiKey: 'b' })).toEqual({ tavilyApiKey: 't' });
    expect(webSearchPayload({ backend: 'searxng', searxngUrl: 'https://s.example.com' })).toEqual({
      searxngUrl: 'https://s.example.com',
    });
  });

  it('trims the configured value', () => {
    expect(webSearchPayload({ backend: 'brave', braveApiKey: '  key  ' })).toEqual({ braveApiKey: 'key' });
  });
});
