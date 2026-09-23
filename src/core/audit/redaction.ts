interface Rule {
  pattern: RegExp;
  /** A `String.replace` replacement; `$1` keeps a captured prefix. */
  replacement: string;
}

// Credentials. Kept apart from the PII rules below so evidence that must stay
// checkable — the tool record the self-test grades against — can drop the
// secrets without also losing the addresses and numbers a claim is about.
const SECRET_RULES: Rule[] = [
  // A private key, to its END line — or to the end of the text when that line
  // was cut off.
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  // Tokens recognisable by their prefix, whatever labels them: OpenAI and
  // Anthropic (sk-, sk-ant-, sk-proj-), GitHub, Slack, Google, Stripe. An
  // `sk-` key has a digit somewhere; `sk-learn-compatible-estimators` does not.
  {
    pattern: /\b(?:sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|[rs]k_(?:live|test)_[A-Za-z0-9]{16,})/g,
    replacement: '[REDACTED_SECRET]',
  },
  { pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, replacement: '$1[REDACTED_SECRET]' },
  // Basic only as a header: on its own, "Basic" is an ordinary word.
  { pattern: /(Authorization:\s*Basic\s+)[A-Za-z0-9+/=]{8,}/gi, replacement: '$1[REDACTED_SECRET]' },
  // The password in a URL's user-info — `postgres://dbuser:hunter2@db/prod`,
  // `redis://:s3cr3t@cache:6379` — which no label points at. The user name
  // stays: it is not the secret, and it says which account the URL was for.
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]*:)[^\s/?#@]+@/gi, replacement: '$1[REDACTED_SECRET]@' },
  // A value ASSIGNED to a password, secret, token or key — `DB_PASSWORD=hunter2`,
  // `"password": "p@ss, w0rd!"`, `?token=abc&` — whatever its length or
  // characters. The label says what it is; a short or punctuated password is
  // no less a password. The label may end a name with nothing between
  // (`PGPASSWORD=`). Quoted, the value runs to the closing quote; bare, to
  // whitespace, a quote or the next query parameter.
  {
    pattern: /((?<![A-Za-z0-9_])(?!REDACTED_)[A-Za-z0-9_]*?(?:passw(?:or)?d|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'&]+)/gi,
    replacement: '$1[REDACTED_SECRET]',
  },
  // A long value labelled as a secret. The label may end a longer name —
  // `ANTHROPIC_API_KEY=`, `GITHUB_TOKEN:` — which a word boundary before it
  // missed, since `_` is a word character. Never the SECRET of an earlier
  // rule's own marker: `[REDACTED_SECRET]@cluster0.example.net` is a host.
  {
    pattern: /((?<![A-Za-z0-9])(?<!REDACTED_)(?:api[_-]?key|secret|token|password|bearer|auth|authorization)[^a-zA-Z0-9_]{1,4})[a-zA-Z0-9_\-.]{16,}/gi,
    replacement: '$1[REDACTED_SECRET]',
  },
  // AWS Access Key ID
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED_AWS_AK]' },
];

const PII_RULES: Rule[] = [
  // IPv4 addresses (basic approximation)
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: '[REDACTED_IP]' },
  // Email addresses
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b/g, replacement: '[REDACTED_EMAIL]' },
  // Phone numbers (simplistic)
  { pattern: /\b(?:\+\d{1,3}[- ]?)?\(?\d{3}\)?[- ]?\d{3}[- ]?\d{4}\b/g, replacement: '[REDACTED_PHONE]' },
];

function apply(rules: readonly Rule[], text: string): string {
  if (!text) return text;
  // A plain replacement string. The callback this replaced took its second
  // argument for a capture group, but a rule with none passes the match's
  // OFFSET there — so an address at offset 7 that contained a 7 had only that
  // digit swapped out, and the rest of it went through.
  return rules.reduce((out, { pattern, replacement }) => out.replace(pattern, replacement), text);
}

export class RedactionLayer {
  /**
   * Applies all redaction rules to the input string.
   */
  public static redact(text: string): string {
    return apply(PII_RULES, apply(SECRET_RULES, text));
  }

  /** Credentials only — see SECRET_RULES. */
  public static redactSecrets(text: string): string {
    return apply(SECRET_RULES, text);
  }
}
