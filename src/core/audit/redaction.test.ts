import { describe, expect, it } from 'vitest';
import { RedactionLayer } from './redaction.js';

describe('RedactionLayer', () => {
  it('redacts IPv4 addresses', () => {
    expect(RedactionLayer.redact('server at 192.168.1.42 responded')).not.toContain('192.168.1.42');
    expect(RedactionLayer.redact('server at 192.168.1.42 responded')).toContain('[REDACTED_IP]');
  });

  it('redacts email addresses', () => {
    const out = RedactionLayer.redact('contact admin@example.com for access');
    expect(out).not.toContain('admin@example.com');
    expect(out).toContain('[REDACTED_EMAIL]');
  });

  it('redacts key-prefixed secrets while keeping the prefix', () => {
    const out = RedactionLayer.redact('api_key: sk_live_abcdef1234567890XYZ');
    expect(out).not.toContain('sk_live_abcdef1234567890XYZ');
    expect(out).toContain('api_key');
    expect(out).toContain('[REDACTED_SECRET]');
  });

  it('redacts AWS access key ids', () => {
    const out = RedactionLayer.redact('found AKIAIOSFODNN7EXAMPLE in config');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('[REDACTED_AWS_AK]');
  });

  it('handles multiple hits in one string', () => {
    const out = RedactionLayer.redact('token: ghp_0123456789abcdef0123 from 10.0.0.5 by bob@corp.io');
    expect(out).not.toContain('ghp_0123456789abcdef0123');
    expect(out).not.toContain('10.0.0.5');
    expect(out).not.toContain('bob@corp.io');
  });

  it('redacts the whole of a match wherever it falls in the text', () => {
    // A rule without a capture group got the match's OFFSET where the
    // callback expected the group, and swapped out only that substring: at
    // offset 7, the "7" of an address that contained one.
    expect(RedactionLayer.redact('server 10.0.0.7')).toBe('server [REDACTED_IP]');
    expect(RedactionLayer.redact('mail: a5@corp.io')).toBe('mail: [REDACTED_EMAIL]');
  });

  it('redacts a secret labelled by the end of a longer name', () => {
    // `_` is a word character, so `\bapi_key` never matched ANTHROPIC_API_KEY.
    const out = RedactionLayer.redact('ANTHROPIC_API_KEY=abcdefghijklmnopqrstuvwx1234');
    expect(out).toBe('ANTHROPIC_API_KEY=[REDACTED_SECRET]');
  });

  it('redacts tokens by their prefix, whatever labels them', () => {
    for (const token of [
      'sk-ant-api03-AbCdEf0123456789AbCdEf0123456789',
      'sk-proj-4f9a2b7c1d8e3f6a0b5c9d2e7f1a4b8c',
      'ghp_0123456789abcdefghijABCDEFGHIJ',
      'github_pat_11ABCDEFG0123456789_abcdefghij',
      'xoxb-1234567890-abcdefghij',
      `AIza${'A1b2C3d4E5'.repeat(3)}12345`,
      'sk_live_0123456789abcdefXYZ',
    ]) {
      expect(RedactionLayer.redactSecrets(`found ${token} here`), token).toBe('found [REDACTED_SECRET] here');
    }
  });

  it('redacts bearer tokens and Basic credentials in a header', () => {
    expect(RedactionLayer.redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'))
      .toBe('Authorization: Bearer [REDACTED_SECRET]');
    expect(RedactionLayer.redactSecrets('Authorization: Basic dXNlcjpwYXNzd29yZA=='))
      .toBe('Authorization: Basic [REDACTED_SECRET]');
  });

  it('redacts a private key, even one cut off before its END line', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    expect(RedactionLayer.redactSecrets(`key:\n${pem}\nafter`)).toBe('key:\n[REDACTED_PRIVATE_KEY]\nafter');
    expect(RedactionLayer.redactSecrets('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg')).toBe('[REDACTED_PRIVATE_KEY]');
  });

  it('leaves ordinary words that look a little like tokens alone', () => {
    const prose = 'Use sk-learn-compatible-estimators with basic internationalization.';
    expect(RedactionLayer.redactSecrets(prose)).toBe(prose);
  });

  it('redactSecrets keeps addresses and numbers, which are not credentials', () => {
    const text = 'admin@example.com at 10.0.0.7, call 555-123-4567';
    expect(RedactionLayer.redactSecrets(text)).toBe(text);
  });

  it('leaves clean text untouched', () => {
    const clean = 'The function returns a sorted list of user names.';
    expect(RedactionLayer.redact(clean)).toBe(clean);
  });

  it('is safe on empty input', () => {
    expect(RedactionLayer.redact('')).toBe('');
  });
});
