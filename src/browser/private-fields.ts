// ─────────────────────────────────────────────
//  Cascade AI — What a private field looks like
// ─────────────────────────────────────────────
//
//  One description, used on both sides of a screenshot: the controller's
//  privacy check (remote/controller.ts), and the person's own device, which
//  blurs every such field before it takes a picture (relay/relay.ts). Plain
//  data, so the extension can bundle it without anything else.

/**
 * `autocomplete` tokens that mark a private field. Matched as tokens, not as
 * the whole attribute: `section-pay billing cc-number` is a card number too.
 * A password field shown in clear by its "show" button is still marked
 * `current-password` or `new-password`.
 */
export const PRIVATE_AUTOCOMPLETE = [
  'current-password', 'new-password', 'one-time-code',
  'cc-name', 'cc-given-name', 'cc-additional-name', 'cc-family-name',
  'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc', 'cc-type',
];
/** Private-field hints cover native inputs and custom text widgets alike. */
export const PRIVATE_FIELDS = [
  'input[type="password" i]',
  ...PRIVATE_AUTOCOMPLETE.map((token) => `[autocomplete~="${token}" i]`),
  // Shown in clear, with no autocomplete to say so, by name or id.
  ...['password', 'passwd', 'cvc', 'cvv', 'cardnumber', 'card_number', 'card-number',
    'cardholder', 'card_holder', 'card-holder', 'nameoncard', 'name_on_card', 'name-on-card']
    .flatMap((word) => [`input[name*="${word}" i]`, `input[id*="${word}" i]`]),
  // Custom checkout fields often omit the cc-exp autocomplete token.
  ...['expiry', 'expiration', 'expires', 'cc-exp', 'cc_exp', 'ccexp', 'card-exp', 'card_exp', 'cardexp',
    'exp-month', 'exp_month', 'expmonth', 'exp-year', 'exp_year', 'expyear', 'exp-date', 'exp_date', 'expdate']
    .flatMap((word) => [`input[name*="${word}" i]`, `input[id*="${word}" i]`]),
  'input[aria-label*="password" i]',
  // A one-time code by its name: sites often leave out the autocomplete
  // token. Generous on purpose — a picture withheld for a field named
  // "footprint" costs a step; a code sent to the model costs an account.
  ...['otp', 'one-time', 'onetime', 'one_time', 'verification', 'passcode', '2fa', 'mfa', 'totp', 'securitycode', 'security_code', 'security-code', 'authcode', 'auth_code', 'auth-code']
    .flatMap((word) => [`input[name*="${word}" i]`, `input[id*="${word}" i]`]),
  // A PIN by its name, as a word of it — `pin`, `card_pin`, `atmPin`,
  // `pin-input`, `user[pin]` — not the "pin" inside "shipping" or "spinner".
  ...['$="pin"', '*="pin_"', '*="pin-"', '*="pin]"', '*="pinnumber"', '*="pincode"']
    .flatMap((match) => [`input[name${match} i]`, `input[id${match} i]`]),
  'input[placeholder*="verification code" i]', 'input[placeholder*="one-time" i]',
  // One box per digit.
  'input[maxlength="1"][inputmode="numeric" i]',
].flatMap((selector) => selector.startsWith('input[')
  ? [selector, `:is(textarea,select,[contenteditable]:not([contenteditable="false" i]),[role="textbox" i],[role="searchbox" i],[role="combobox" i],[role="spinbutton" i])${selector.slice('input'.length)}`]
  : [selector]).join(', ');
/**
 * Fields known only by their label — a `<label>`, `aria-label` or
 * `aria-labelledby` — and no name or id that says what they hold.
 */
export const PRIVATE_LABEL = /(?:pin|cv[cv]|otp)[\s_-]*(?:code|number)|password|passcode|one[\s-]?time|verification[\s_-]*code|verify[\s_-]*code|security[\s_-]*code|auth(?:entication|orization)?[\s_-]*code|access[\s_-]*code|sign[\s_-]*in[\s_-]*code|login[\s_-]*code|\botp(?:[\s_-]*code)?\b|\b2fa\b|two[\s-]?(?:factor|step)|\bmfa\b|\bpin(?:[\s_-]*(?:code|number))?\b|card[\s_-]*number|(?:name\s+on\s+(?:the\s+)?card|card[\s_-]*holder(?:[\s_-]*name)?|cardholder[\s_-]*name)|\bcvc(?:[\s_-]*(?:code|number))?\b|\bcvv(?:[\s_-]*(?:code|number))?\b|\bexpir(?:y|ation|es?)\b|\bexp\.?\s*(?:date|month|year)\b|\bmm\s*[/\-]\s*y{2}(?:y{2})?\b/i;
/**
 * Placeholders that say the same, and the digits a card field shows before
 * one is typed: "Card number", "1234 1234 1234 1234", "•••• ••••".
 * Split expiry placeholders are conservative: ordinary date fields using
 * MM, YY or YYYY also withhold the picture.
 */
export const PRIVATE_PLACEHOLDER = new RegExp(`${PRIVATE_LABEL.source}|^\\s*(?:mm|yy|yyyy)\\s*$|\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}|[•*x]{4}[\\s-]?[•*x]{4}`, 'i');
