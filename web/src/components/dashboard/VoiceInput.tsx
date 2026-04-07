import React, { memo } from 'react';

/**
 * VoiceInput — Web Speech API stub
 *
 * Future roadmap feature: allows users to dictate tasks instead of typing.
 * Enable by setting `dashboard.voiceInput: true` in config.yaml.
 *
 * @status STUB — not yet functional
 * @roadmap See ROADMAP.md → "Voice Input"
 */

const IS_SUPPORTED = typeof window !== 'undefined' && 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;

interface VoiceInputProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

export const VoiceInput = memo(function VoiceInput({ onTranscript, disabled }: VoiceInputProps) {
  // TODO: Wire Web Speech API in a follow-up.
  // 1. Create a SpeechRecognition instance
  // 2. On result, call onTranscript(event.results[0][0].transcript)
  // 3. Show animated mic indicator while recording

  if (!IS_SUPPORTED) return null;

  return (
    <button
      aria-label="Voice input (coming soon)"
      disabled={disabled ?? true}  // disabled until the stub is implemented
      title="Voice input — coming soon"
      className="w-8 h-8 rounded-full flex items-center justify-center
                 text-[var(--text-faint)] opacity-40 cursor-not-allowed
                 border border-[var(--border-subtle)]"
    >
      🎤
    </button>
  );
});
