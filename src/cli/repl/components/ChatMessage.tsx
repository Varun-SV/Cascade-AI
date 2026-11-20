// ─────────────────────────────────────────────
//  Cascade AI — Chat Message Component
// ─────────────────────────────────────────────

import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import type { Theme } from '../../../types.js';
import { chartKind, parseChartSpec } from '../../../core/documents/blocks.js';
import { chartToLines } from '../../visuals/chart-text.js';
import { fileLink, findImages, type Thumbnails } from '../../visuals/terminal-image.js';

interface ChatMessageProps {
  role: 'user' | 'assistant' | 'system' | 'error';
  content: string | unknown;
  theme: Theme;
  timestamp?: string;
  isStreaming?: boolean;
  /** Thumbnails for the images the reply shows, made before it was written (see terminal-image.ts). */
  thumbnails?: Thumbnails;
  /** Columns to draw charts in; the terminal's width when not given. */
  width?: number;
}

export function ChatMessage({ role, content, theme, timestamp, isStreaming, thumbnails, width }: ChatMessageProps): React.ReactElement {
  const { label, color, prefix } = getRoleStyle(role, theme);

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text color={color} bold>{prefix} {label}</Text>
        {timestamp && <Text color={theme.colors.muted}> {formatTime(timestamp)}</Text>}
        {isStreaming && <Text color={theme.colors.accent}> ⟳</Text>}
      </Box>
      <Box marginLeft={2} flexDirection="column">
        {renderContent(normalizeContent(content), theme, thumbnails ?? {}, (width ?? process.stdout.columns ?? 80) - 6)}
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

// Cap rendered code blocks so a giant snippet can't dominate the scrollback
// commit (and, while still live, can't push the layout past the viewport).
const MAX_CODE_LINES = 40;

function renderContent(content: string, theme: Theme, thumbnails: Thumbnails, width: number): React.ReactElement[] {
  // Split into code blocks and text
  const parts = content.split(/(```[\s\S]*?```)/g);

  return parts.flatMap((part, i): React.ReactElement[] => {
    if (part.startsWith('```')) {
      const lines = part.split('\n');
      const lang = lines[0]?.replace('```', '').trim() ?? '';
      const codeLines = lines.slice(1, -1);
      // A chart the reply drew as data: drawn here too, and kept as code when it doesn't parse.
      const chart = /^chart\s*:/i.test(lang) ? chartKind(lang.replace(/^chart\s*:/i, '')) : null;
      const spec = chart ? parseChartSpec(chart, codeLines.join('\n')) : null;
      if (spec) {
        return [(
          <Box key={i} flexDirection="column" marginY={1} paddingX={1} borderStyle="round" borderColor={theme.colors.border}>
            {chartToLines(spec, width - 4).map((line, j) => <Text key={j} wrap="truncate-end">{line || ' '}</Text>)}
          </Box>
        )];
      }
      const truncated = codeLines.length - MAX_CODE_LINES;
      const code = codeLines.slice(0, MAX_CODE_LINES).join('\n');
      return [(
        <Box key={i} flexDirection="column" marginY={1} paddingX={2}
          borderStyle="single" borderColor={theme.colors.border}>
          {lang && <Text color={theme.colors.muted}>{lang}</Text>}
          <Text>{code}</Text>
          {truncated > 0 && (
            <Text color={theme.colors.muted} dimColor>… ({truncated} more lines — /export to get the full text)</Text>
          )}
        </Box>
      )];
    }

    // Text, with each image it shows drawn in its place.
    const out: React.ReactElement[] = [];
    let at = 0;
    for (const img of findImages(part)) {
      if (img.start > at) out.push(<Text key={`${i}-t${at}`} wrap="wrap">{inline(part.slice(at, img.start), theme)}</Text>);
      out.push(imageBlock(`${i}-i${img.start}`, img.alt, img.src, thumbnails[img.src], theme));
      at = img.end;
    }
    if (at < part.length) out.push(<Text key={`${i}-t${at}`} wrap="wrap">{inline(part.slice(at), theme)}</Text>);
    return out;
  });
}

// Render inline markdown-ish
function inline(text: string, theme: Theme): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, (_, t) => chalk.bold(t))
    .replace(/`(.*?)`/g, (_, t) => chalk.bgHex(theme.colors.border)(t));
}

/** An image: its thumbnail and a link to open it, or, with none, what it is and where. */
function imageBlock(key: string, alt: string, src: string, thumb: Thumbnails[string] | undefined, theme: Theme): React.ReactElement {
  const label = alt.trim() || 'image';
  if (!thumb) {
    return <Text key={key} color={theme.colors.muted} wrap="wrap">{`▣ ${label}  `}{chalk.underline(src)}</Text>;
  }
  return (
    <Box key={key} flexDirection="column" marginY={1}>
      {thumb.lines.map((line, j) => <Text key={j}>{line}</Text>)}
      <Text color={theme.colors.muted} wrap="truncate-end">{`▣ ${label}  `}{fileLink(thumb.file, chalk.underline('open full size'))}</Text>
    </Box>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}
