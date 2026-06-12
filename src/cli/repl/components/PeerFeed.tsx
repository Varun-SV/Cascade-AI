// ─────────────────────────────────────────────
//  Cascade AI — Peer Comms Feed (agent-to-agent radio chatter)
// ─────────────────────────────────────────────
//
//  Live ticker of PeerBus traffic: T3↔T3 / T2↔T2 messages, broadcasts,
//  file locks, and barrier arrivals. No other CLI has agent-to-agent
//  communication at all — this panel is what makes the hierarchy feel
//  like a team working in front of you.
//
//  Fixed height so the live area never outgrows the viewport.

import React from 'react';
import { Box, Text } from 'ink';
import type { PeerMessageEvent, Theme } from '../../../types.js';

interface PeerFeedProps {
  events: PeerMessageEvent[];
  theme: Theme;
  /** Rows of events to show (panel adds 1 header row). */
  maxRows?: number;
}

function tierColor(id: string, theme: Theme): string {
  const lower = id.toLowerCase();
  if (lower.startsWith('t1')) return theme.colors.t1Color;
  if (lower.startsWith('t2')) return theme.colors.t2Color;
  return theme.colors.t3Color;
}

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 15)}…` : id;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function PeerFeedInternal({ events, theme, maxRows = 5 }: PeerFeedProps): React.ReactElement | null {
  if (!events.length) return null;

  const visible = events.slice(-maxRows);

  return (
    <Box flexDirection="column" paddingLeft={1} height={visible.length + 1}>
      <Text color={theme.colors.muted} bold>⇄ Agent comms</Text>
      {visible.map((ev, i) => {
        const isCoordination = ev.syncType === 'COORDINATION';
        const target = ev.toId ? shortId(ev.toId) : 'all';
        const payload = (ev.payload ?? '').replace(/\s+/g, ' ').trim();
        return (
          <Box key={`${ev.timestamp}-${ev.fromId}-${i}`}>
            <Text color={theme.colors.muted} dimColor>  {formatTime(ev.timestamp)} </Text>
            <Text color={tierColor(ev.fromId, theme)}>{shortId(ev.fromId)}</Text>
            {isCoordination ? (
              <Text color={theme.colors.muted} wrap="truncate-end">  {payload}</Text>
            ) : (
              <>
                <Text color={theme.colors.muted}> → </Text>
                <Text color={ev.toId ? tierColor(ev.toId, theme) : theme.colors.accent}>{target}</Text>
                <Text color={theme.colors.muted} dimColor>  {ev.syncType}</Text>
                {payload ? <Text color={theme.colors.foreground} wrap="truncate-end">  “{payload.slice(0, 60)}{payload.length > 60 ? '…' : ''}”</Text> : null}
              </>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

export const PeerFeed = React.memo(PeerFeedInternal);
