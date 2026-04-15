// ─────────────────────────────────────────────
//  Cascade AI — Chat Message Component
// ─────────────────────────────────────────────

import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import type { Theme } from '../../../types.js';

interface ChatMessageProps {
  role: 'user' | 'assistant' | 'system' | 'error';
  content: string | unknown;
  theme: Theme;
  timestamp?: string;
  isStreaming?: boolean;
}

export function ChatMessage({ role, content, theme, timestamp, isStreaming }: ChatMessageProps): React.ReactElement {
  const { label, color, prefix } = getRoleStyle(role, theme);

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text color={color} bold>{prefix} {label}</Text>
        {timestamp && <Text color={theme.colors.muted}> {formatTime(timestamp)}</Text>}
        {isStreaming && <Text color={theme.colors.accent}> ⟳</Text>}
      </Box>
      <Box marginLeft={2} flexDirection="column">
        {renderContent(normalizeContent(content), theme)}
      </Box>
    </Box>
  );
}

function getRoleStyle(role: ChatMessageProps['role'], theme: Theme) {
  switch (role) {
    case 'user':
      return { label: 'USER', color: theme.colors.primary, prefix: '▸' };
    case 'assistant':
      return { label: 'CASCADE', color: theme.colors.accent, prefix: '◈' };
    case 'system':
      return { label: 'SYSTEM', color: theme.colors.muted, prefix: '◦' };
    case 'error':
      return { label: 'ERROR', color: theme.colors.error, prefix: '✗' };
  }
}

function normalizeContent(content: string | unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return typeof part === 'object' ? JSON.stringify(part) : String(part);
    }).join(' ');
  }
  return typeof content === 'object' ? JSON.stringify(content) : String(content);
}

function renderContent(content: string, theme: Theme): React.ReactElement[] {
  // Split into code blocks and text
  const parts = content.split(/(```[\s\S]*?```)/g);

  return parts.map((part, i) => {
    if (part.startsWith('```')) {
      const lines = part.split('\n');
      const lang = lines[0]?.replace('```', '').trim() ?? '';
      const code = lines.slice(1, -1).join('\n');
      return (
        <Box key={i} flexDirection="column" marginY={1} paddingX={2}
          borderStyle="single" borderColor={theme.colors.border}>
          {lang && <Text color={theme.colors.muted}>{lang}</Text>}
          <Text>{code}</Text>
        </Box>
      );
    }

    // Render inline markdown-ish
    const rendered = part
      .replace(/\*\*(.*?)\*\*/g, (_, t) => chalk.bold(t))
      .replace(/`(.*?)`/g, (_, t) => chalk.bgHex(theme.colors.border)(t));

    return <Text key={i} wrap="wrap">{rendered}</Text>;
  });
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}
