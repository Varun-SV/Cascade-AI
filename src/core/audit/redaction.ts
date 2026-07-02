export class RedactionLayer {
  // Regexes for common secrets/PII
  private static readonly RULES = [
    // IPv4 addresses (basic approximation)
    { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: '[REDACTED_IP]' },
    // Generic API keys/Secrets (looks like a long random hex or b64 string preceded by key/secret/token)
    { pattern: /(?:\b(?:api_key|apikey|secret|token|password|bearer|auth|authorization)\b[^a-zA-Z0-9_]{1,4})([a-zA-Z0-9_\-\.]{16,})/gi, replacement: '$1[REDACTED_SECRET]' },
    // Email addresses
    { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b/g, replacement: '[REDACTED_EMAIL]' },
    // Phone numbers (simplistic)
    { pattern: /\b(?:\+\d{1,3}[- ]?)?\(?\d{3}\)?[- ]?\d{3}[- ]?\d{4}\b/g, replacement: '[REDACTED_PHONE]' },
    // AWS Access Key ID
    { pattern: /\b(AKIA[0-9A-Z]{16})\b/g, replacement: '[REDACTED_AWS_AK]' },
  ];

  /**
   * Applies all redaction rules to the input string.
   */
  public static redact(text: string): string {
    if (!text) return text;
    let redacted = text;
    for (const rule of this.RULES) {
      if (rule.pattern.test(redacted)) {
         // Reset lastIndex since we are reusing the regex or just use replace with string replacer
         rule.pattern.lastIndex = 0;
         redacted = redacted.replace(rule.pattern, (match, p1, offset, str) => {
             // For rules that use a capture group (like the API key rule), we want to preserve the prefix
             if (p1 && match.includes(p1) && p1 !== match) {
                 return match.replace(p1, rule.replacement.replace('$1', ''));
             }
             return rule.replacement;
         });
      }
    }
    return redacted;
  }
}
