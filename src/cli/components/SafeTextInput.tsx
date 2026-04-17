// ─────────────────────────────────────────────
//  Cascade AI — SafeTextInput
// ─────────────────────────────────────────────
//
//  A drop-in replacement for `ink-text-input` that fixes three real-world
//  papercuts observed on Windows consoles and some SSH terminals:
//
//    1. Ctrl+V (and Ctrl+Shift+V) insert a literal "v" instead of pasting.
//       Ink treats Ctrl+V as a modified keypress; the terminal never
//       converts it into clipboard bytes in raw mode. We intercept the
//       keypress ourselves and read the system clipboard via a small
//       cross-platform shell-out.
//
//    2. Right-click / scroll wheel / other mouse events emit raw SGR
//       sequences like `\x1b[<2;98;44M` which end up typed into the
//       field. We disable mouse reporting on mount and strip any
//       sequences that still arrive.
//
//    3. Bracketed-paste content (ESC[200~…ESC[201~) from modern terminals
//       is captured in a single insert rather than being processed one
//       character at a time.
//
//  The prop surface mirrors ink-text-input so existing call sites can
//  swap the component with no other changes.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, useInput } from 'ink';
import chalk from 'chalk';
import {
  PASTE_START,
  PASTE_END,
  sanitizeTerminalInput,
  enableBracketedPaste,
  disableBracketedPaste,
  disableMouseReporting,
} from '../utils/terminal-input.js';
import { readClipboardSync } from '../utils/clipboard.js';

export interface SafeTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  /** When set, displayed characters are replaced with this glyph (for API keys). */
  mask?: string;
  focus?: boolean;
  showCursor?: boolean;
  /** Disable the Ctrl+V clipboard fallback. Defaults to `false`. */
  disableClipboardFallback?: boolean;
  /**
   * When `true` (default) the component disables mouse reporting on mount.
   * Set to `false` from hosts (e.g. the REPL) that keep mouse reporting
   * enabled for scroll-wheel handling.
   */
  manageMouseReporting?: boolean;
}

const PASTE_BUFFER_TIMEOUT_MS = 500;

export function SafeTextInput(props: SafeTextInputProps): React.ReactElement {
  const {
    value,
    onChange,
    onSubmit,
    placeholder = '',
    mask,
    focus = true,
    showCursor = true,
    disableClipboardFallback = false,
    manageMouseReporting = true,
  } = props;

  const [cursorOffset, setCursorOffset] = useState<number>(value.length);

  const valueRef = useRef(value);
  valueRef.current = value;
  const cursorRef = useRef(cursorOffset);
  cursorRef.current = cursorOffset;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  // Keep cursor within bounds when value shrinks externally.
  useEffect(() => {
    if (cursorOffset > value.length) setCursorOffset(value.length);
  }, [value, cursorOffset]);

  // Insert text at the current cursor position.
  const insertAtCursor = useCallback((text: string) => {
    const v = valueRef.current;
    const c = cursorRef.current;
    const next = v.slice(0, c) + text + v.slice(c);
    valueRef.current = next;
    const nextCursor = c + text.length;
    cursorRef.current = nextCursor;
    setCursorOffset(nextCursor);
    onChangeRef.current(next);
  }, []);

  // Bracketed-paste buffer state.
  const pasteBufferRef = useRef<string | null>(null);
  const pasteTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Tracks the most recent forward-delete (ESC[3~) handled in the raw stdin
  // listener. Ink surfaces BOTH backspace (\x7F) and forward-delete (\x1b[3~)
  // as `key.delete = true`, so useInput cannot distinguish them. We handle
  // forward-delete in the raw listener and set this timestamp so the
  // useInput handler can ignore the duplicate event that Ink is about to
  // fire for the same keystroke.
  const lastForwardDeleteRef = useRef<number>(0);

  const flushPaste = useCallback(() => {
    const buf = pasteBufferRef.current;
    pasteBufferRef.current = null;
    if (pasteTimerRef.current) { clearTimeout(pasteTimerRef.current); pasteTimerRef.current = null; }
    if (buf === null) return;
    const content = sanitizeTerminalInput(buf);
    if (content) insertAtCursor(content);
  }, [insertAtCursor]);

  // Enable bracketed paste + (optionally) disable mouse reporting on mount.
  useEffect(() => {
    enableBracketedPaste();
    if (manageMouseReporting) disableMouseReporting();
    return () => {
      disableBracketedPaste();
      if (pasteTimerRef.current) clearTimeout(pasteTimerRef.current);
    };
  }, [manageMouseReporting]);

  // Raw stdin listener — captures bracketed-paste content before Ink
  // splits it into per-character keypress events.
  useEffect(() => {
    const onData = (data: Buffer) => {
      if (!focusRef.current) return;
      const chunk = data.toString('utf8');

      // Continue an in-flight paste.
      if (pasteBufferRef.current !== null) {
        const endIdx = chunk.indexOf(PASTE_END);
        if (endIdx === -1) {
          pasteBufferRef.current += chunk;
        } else {
          pasteBufferRef.current += chunk.slice(0, endIdx);
          flushPaste();
        }
        return;
      }

      // Detect a new paste.
      const startIdx = chunk.indexOf(PASTE_START);
      if (startIdx !== -1) {
        const after = chunk.slice(startIdx + PASTE_START.length);
        const endIdx = after.indexOf(PASTE_END);
        if (endIdx !== -1) {
          const pasted = sanitizeTerminalInput(after.slice(0, endIdx));
          if (pasted) insertAtCursor(pasted);
        } else {
          pasteBufferRef.current = after;
          pasteTimerRef.current = setTimeout(flushPaste, PASTE_BUFFER_TIMEOUT_MS);
        }
        return;
      }

      // Forward-delete key: ESC[3~ (PC Delete, not Backspace).
      // Ink will also dispatch this as `key.delete = true`, which our
      // useInput handler treats as backspace. We pre-empt it here so the
      // character at the cursor is removed instead of the character before
      // the cursor, and record the timestamp so useInput can skip the
      // duplicate event. The chunk can contain other keypress bytes on
      // some terminals, so we match both an exact equal and an endsWith.
      if (chunk === '\x1b[3~' || chunk.endsWith('\x1b[3~')) {
        lastForwardDeleteRef.current = Date.now();
        const c = cursorRef.current;
        const v = valueRef.current;
        if (c < v.length) {
          const next = v.slice(0, c) + v.slice(c + 1);
          valueRef.current = next;
          onChangeRef.current(next);
          // Cursor stays where it is for forward-delete.
        }
        return;
      }
    };

    process.stdin.on('data', onData);
    return () => { process.stdin.off('data', onData); };
  }, [flushPaste, insertAtCursor]);

  useInput((input, key) => {
    if (!focusRef.current) return;

    // Ignore outer navigation keys — let the parent component act on them.
    if (key.upArrow || key.downArrow || key.tab || (key.shift && key.tab)) return;
    if (key.ctrl && input === 'c') return;

    // Ctrl+V / Ctrl+Shift+V → read clipboard.
    if (key.ctrl && (input === 'v' || input === 'V')) {
      if (disableClipboardFallback) return;
      const text = readClipboardSync();
      if (text) {
        const sanitized = sanitizeTerminalInput(text);
        if (sanitized) insertAtCursor(sanitized);
      }
      return;
    }

    if (key.return) {
      onSubmitRef.current?.(valueRef.current);
      return;
    }

    if (key.leftArrow) {
      setCursorOffset(c => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursorOffset(c => Math.min(valueRef.current.length, c + 1));
      return;
    }

    // Home / End (these arrive via `key.ctrl` flags in some terminals;
    // ink doesn't map them natively — we simply support the common case).
    if (key.backspace || key.delete) {
      // Ink surfaces BOTH \x7F (backspace) and \x1b[3~ (forward-delete) as
      // `key.delete = true`. The raw stdin listener already handled the
      // forward-delete case; if that fired within the last few ms, this
      // duplicate event should be ignored to avoid deleting a second char.
      if (Date.now() - lastForwardDeleteRef.current < 50) return;
      const v = valueRef.current;
      const c = cursorRef.current;
      if (c === 0) return;
      const next = v.slice(0, c - 1) + v.slice(c);
      valueRef.current = next;
      const nextCursor = c - 1;
      cursorRef.current = nextCursor;
      setCursorOffset(nextCursor);
      onChangeRef.current(next);
      return;
    }

    if (!input) return;

    // Any modifier-key combo we don't explicitly handle is ignored so
    // that stray Ctrl+<letter> keystrokes don't type a literal letter.
    if (key.ctrl || key.meta) return;

    // Strip escape sequences / control characters that slipped through.
    const cleaned = sanitizeTerminalInput(input);
    if (cleaned.length === 0) return;
    insertAtCursor(cleaned);
  }, { isActive: focus });

  // ── Render ──────────────────────────────────────
  const displayValue = mask ? mask.repeat(value.length) : value;

  let rendered: string;
  if (displayValue.length === 0) {
    rendered = showCursor && focus
      ? (placeholder.length > 0 ? chalk.inverse(placeholder[0]!) + chalk.grey(placeholder.slice(1)) : chalk.inverse(' '))
      : (placeholder.length > 0 ? chalk.grey(placeholder) : '');
  } else if (!showCursor || !focus) {
    rendered = displayValue;
  } else {
    let out = '';
    for (let i = 0; i < displayValue.length; i++) {
      out += i === cursorOffset ? chalk.inverse(displayValue[i]!) : displayValue[i]!;
    }
    if (cursorOffset >= displayValue.length) out += chalk.inverse(' ');
    rendered = out;
  }

  return <Text>{rendered}</Text>;
}

export default SafeTextInput;
