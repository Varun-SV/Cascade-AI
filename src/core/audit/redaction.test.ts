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

  it('leaves clean text untouched', () => {
    const clean = 'The function returns a sorted list of user names.';
    expect(RedactionLayer.redact(clean)).toBe(clean);
  });

  it('is safe on empty input', () => {
    expect(RedactionLayer.redact('')).toBe('');
  });
});
