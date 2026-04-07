import React, { memo } from 'react';

/**
 * VoiceInput — Web Speech API stub.
 *
 * Roadmap feature: lets users dictate tasks instead of typing.
 * Enable by setting `dashboard.voiceInput: true` in config.yaml.
 *
 * @status STUB — not yet wired
 * @roadmap ROADMAP.md → "Voice Input"
 *
 * Bug fixed: the original expression
 *
 *   typeof window !== 'undefined' && 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window
 *
 * evaluates as
 *
 *   (typeof window !== 'undefined' && 'SpeechRecognition' in window) || ('webkitSpeechRecognition' in window)
 *
 * due to operator precedence, so the SSR guard (`typeof window !== 'undefined'`)
 * does NOT protect the webkit check — it can throw ReferenceError in SSR.
 * Fixed by wrapping the whole browser check.
 */

const IS_SUPPORTED =
  typeof window !== 'undefined' &&
  ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

interface VoiceInputProps {
  /** Called when a transcript is available. */
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

export const VoiceInput = memo(function VoiceInput({ disabled }: VoiceInputProps) {
  // TODO (roadmap): Wire Web Speech API
  // 1. const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  // 2. const rec = new Recognition();
  // 3. rec.onresult = (e) => onTranscript(e.results[0]![0]!.transcript);
  // 4. Toggle rec.start() / rec.stop() on button click.
  // 5. Show animated mic ring while recording.

  if (!IS_SUPPORTED) return null;

  return (
    <button
      type="button"
      aria-label="Voice input — coming soon"
      title="Voice input — coming soon"
      disabled={disabled ?? true}
      className="
        w-7 h-7 rounded-full flex items-center justify-center
        text-[var(--text-faint)] opacity-40 cursor-not-allowed
        border border-[var(--border-subtle)]
        transition-opacity
      "
    >
      <span aria-hidden="true" className="text-[13px]">🎤</span>
    </button>
  );
});