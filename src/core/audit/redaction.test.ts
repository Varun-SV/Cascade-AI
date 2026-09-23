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

  it('redacts a value assigned to a password, secret or token, however short or punctuated', () => {
    // Only 16+ token-shaped characters used to count, so the commonest
    // credential in a tool result — a short password in a .env — went through.
    expect(RedactionLayer.redactSecrets('DB_PASSWORD=hunter2\nDB_HOST=db')).toBe('DB_PASSWORD=[REDACTED_SECRET]\nDB_HOST=db');
    expect(RedactionLayer.redactSecrets('DB_PASSWORD=p@ss!w0rd#1')).toBe('DB_PASSWORD=[REDACTED_SECRET]');
    expect(RedactionLayer.redactSecrets('{"password": "p@ss, w0rd!", "user": "bob"}')).toBe('{"password": [REDACTED_SECRET], "user": "bob"}');
    expect(RedactionLayer.redactSecrets('password: hunter2')).toBe('password: [REDACTED_SECRET]');
    expect(RedactionLayer.redactSecrets('CLIENT_SECRET=x')).toBe('CLIENT_SECRET=[REDACTED_SECRET]');
    expect(RedactionLayer.redactSecrets('https://api.test/v1?token=abc&page=2')).toBe('https://api.test/v1?token=[REDACTED_SECRET]&page=2');
  });

  it('redacts the password in a connection URL, which no label points at', () => {
    expect(RedactionLayer.redactSecrets('DATABASE_URL=postgres://dbuser:hunter2@db.example.com/prod'))
      .toBe('DATABASE_URL=postgres://dbuser:[REDACTED_SECRET]@db.example.com/prod');
    expect(RedactionLayer.redactSecrets('REDIS_URL=redis://:s3cr3t@cache:6379/0'))
      .toBe('REDIS_URL=redis://:[REDACTED_SECRET]@cache:6379/0');
    expect(RedactionLayer.redactSecrets('mongodb+srv://app:p%40ss@cluster0.example.net/db'))
      .toBe('mongodb+srv://app:[REDACTED_SECRET]@cluster0.example.net/db');
  });

  it('does not read its own marker as a label and redact what follows it', () => {
    // [REDACTED_SECRET] contains SECRET, and the long-value rule took it for
    // one: a host of 16+ characters after a redacted password went too.
    expect(RedactionLayer.redactSecrets('https://app:pw@cluster0.example.net/db'))
      .toBe('https://app:[REDACTED_SECRET]@cluster0.example.net/db');
    expect(RedactionLayer.redactSecrets('[REDACTED_SECRET] - averyverylongidentifier'))
      .toBe('[REDACTED_SECRET] - averyverylongidentifier');
  });

  it('leaves a URL with a port and no user-info alone', () => {
    const text = 'see https://example.com:8080/path?q=1 and ssh://git@github.com/org/repo';
    expect(RedactionLayer.redactSecrets(text)).toBe(text);
  });

  it('redacts the credentials a connection string names', () => {
    // No distinctive prefix and no password-like label: an Azure storage
    // account key went through untouched.
    const azure = 'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=Zm9vYmFyYmF6cXV4MTIz==;EndpointSuffix=core.windows.net';
    expect(RedactionLayer.redactSecrets(azure)).not.toContain('Zm9vYmFyYmF6cXV4MTIz');
    expect(RedactionLayer.redactSecrets(azure)).toContain('AccountName=x;AccountKey=[REDACTED_SECRET]');
    const bus = 'Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=Root;SharedAccessKey=c2VjcmV0';
    expect(RedactionLayer.redactSecrets(bus)).toBe('Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=Root;SharedAccessKey=[REDACTED_SECRET]');
    expect(RedactionLayer.redactSecrets("SECRET_KEY='django-insecure-abc'")).toBe('SECRET_KEY=[REDACTED_SECRET]');
  });

  it('redacts the signature on a signed URL, which is all its holder needs', () => {
    expect(RedactionLayer.redactSecrets('https://a.blob.core.windows.net/c/b?sv=2021-08-06&se=2026-01-01&sig=AbC%2Bdef%3D'))
      .toBe('https://a.blob.core.windows.net/c/b?sv=2021-08-06&se=2026-01-01&sig=[REDACTED_SECRET]');
    expect(RedactionLayer.redactSecrets('SharedAccessSignature=sv=2021&sig=AbCdef'))
      .not.toContain('AbCdef');
    expect(RedactionLayer.redactSecrets('https://b.s3.amazonaws.com/k?X-Amz-Expires=60&X-Amz-Signature=deadbeef01'))
      .toBe('https://b.s3.amazonaws.com/k?X-Amz-Expires=60&X-Amz-Signature=[REDACTED_SECRET]');
  });

  it('redacts a password whose label is glued to the name before it', () => {
    expect(RedactionLayer.redactSecrets('PGPASSWORD=hunter2 psql')).toBe('PGPASSWORD=[REDACTED_SECRET] psql');
  });

  it('leaves a label that assigns nothing alone', () => {
    const text = 'Enter your password below. tokens: 1234. DB_PASSWORD_FILE=/run/secrets/db';
    expect(RedactionLayer.redactSecrets(text)).toBe(text);
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

  it('redacts an Authorization header however short its credential', () => {
    expect(RedactionLayer.redactSecrets('Authorization: Bearer short7')).toBe('Authorization: Bearer [REDACTED_SECRET]');
    expect(RedactionLayer.redactSecrets('Authorization: Basic YTpi')).toBe('Authorization: Basic [REDACTED_SECRET]');
    expect(RedactionLayer.redactSecrets('proxy-authorization: basic YTpi\nnext line'))
      .toBe('proxy-authorization: basic [REDACTED_SECRET]\nnext line');
    expect(RedactionLayer.redactSecrets("curl -H 'Authorization: token abc' https://api.test"))
      .toBe("curl -H 'Authorization: token [REDACTED_SECRET]' https://api.test");
    expect(RedactionLayer.redactSecrets('{"Authorization":"Bearer t","Accept":"*/*"}'))
      .toBe('{"Authorization":"Bearer [REDACTED_SECRET]","Accept":"*/*"}');
  });

  it('redacts the whole value of an Authorization header whose scheme it does not know', () => {
    expect(RedactionLayer.redactSecrets('Authorization: Digest username="bob", response="6629fae4"\nHost: api.test'))
      .toBe('Authorization: [REDACTED_SECRET]"\nHost: api.test');
    expect(RedactionLayer.redactSecrets('curl -H "Authorization: $KEY" https://api.test'))
      .toBe('curl -H "Authorization: [REDACTED_SECRET]" https://api.test');
    expect(RedactionLayer.redactSecrets('{"authorization":"SSWS 00ab"}')).toBe('{"authorization":[REDACTED_SECRET]}');
  });

  it('redacts cookies, sent and set', () => {
    expect(RedactionLayer.redactSecrets('Cookie: sid=abc; theme=dark\nHost: api.test'))
      .toBe('Cookie: [REDACTED_SECRET]\nHost: api.test');
    expect(RedactionLayer.redactSecrets('Set-Cookie: sid=abc; Path=/; HttpOnly')).toBe('Set-Cookie: [REDACTED_SECRET]');
    expect(RedactionLayer.redactSecrets('curl -H "Cookie: sid=abc" https://api.test'))
      .toBe('curl -H "Cookie: [REDACTED_SECRET]" https://api.test');
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
