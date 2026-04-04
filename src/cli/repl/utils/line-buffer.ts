// ─────────────────────────────────────────────
//  Cascade AI — Line Buffer Utility
// ─────────────────────────────────────────────

import wrapAnsi from 'wrap-ansi';
import chalk from 'chalk';
import type { Message, Theme } from '../../../types.js';

/**
 * Converts a conversation history into a flat array of formatted lines,
 * respecting terminal width and applying word-wrapping.
 */
export function formatToLines(messages: Message[], width: number, theme: Theme): string[] {
  const lines: string[] = [];

  for (const msg of messages) {
    const { label, color, prefix } = getRoleStyle(msg.role, theme);
    
    // 1. Header (Role + Timestamp)
    const time = msg.timestamp ? ` ${chalk.hex(theme.colors.muted)(new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}` : '';
    lines.push(`${color(prefix)} ${color.bold(label)}${time}`);
    
    // 2. Content
    const content = normalizeContent(msg.content);
    const formattedContent = formatMarkdownish(content, theme);
    
    // Wrap the content (with indentation)
    const wrapped = wrapAnsi(formattedContent, width - 4, { hard: true, trim: false });
    const contentLines = wrapped.split('\n');
    
    for (const line of contentLines) {
      lines.push(`  ${line}`); // Indent content for readability
    }
    
    // 3. Spacing
    lines.push('');
  }

  return lines;
}

function getRoleStyle(role: Message['role'], theme: Theme) {
  switch (role) {
    case 'user':
      return { label: 'You', color: chalk.hex(theme.colors.primary), prefix: '▸' };
    case 'assistant':
      return { label: 'Cascade', color: chalk.hex(theme.colors.secondary), prefix: '◈' };
    case 'system':
      return { label: 'System', color: chalk.hex(theme.colors.muted), prefix: '◦' };
    case 'error':
      return { label: 'Error', color: chalk.hex(theme.colors.error), prefix: '✗' };
    default:
      return { label: 'Unknown', color: chalk.white, prefix: '?' };
  }
}

function normalizeContent(content: string | unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
  }
  return typeof content === 'object' ? JSON.stringify(content) : String(content);
}

function formatMarkdownish(content: string, theme: Theme): string {
  return content
    .replace(/\*\*(.*?)\*\*/g, (_, t) => chalk.bold(t))
    .replace(/`(.*?)`/g, (_, t) => chalk.inverse(t))
    .replace(/```([\s\S]*?)```/g, (_, code) => {
      // For simple inline viewport, we'll just dim code blocks or give them a subtle background
      return chalk.dim(code.trim());
    });
}
