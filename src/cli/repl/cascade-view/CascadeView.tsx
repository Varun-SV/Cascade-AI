// ─────────────────────────────────────────────
//  Cascade AI — The cascade, live
// ─────────────────────────────────────────────
//
//  The run's tree is the main view; the node you pick (or, until you pick
//  one, the busiest) shows what it is doing beside it on a wide terminal,
//  under it on a narrow one:
//
//  T1 ▸ Build usage tracker  ██████░░ 3/4 │ T3 · Web dashboard & API          1:12
//  ├─ T2 ✔ Core storage & ingestion  2:03 │ ∙ routes first, then the templates…
//  │  ├─ T3 ✔ Database schema         0:41 │ ▸ file_write  src/api.py      +84 −0
//  │  └─ T3 ✔ Copilot API client      1:12 │ ▸ shell       pytest -q       12 passed
//  └─ T2 ◐ Dashboard, CLI & verify         │ ◐ file_write  templates/index.html
//     ├─ T3 ◐ Web dashboard & API  ◀       │
//     └─ T3 ○ CLI & verification   waiting │ comms  T3·db released src/db.py

import React from 'react';
import { Box, Text } from 'ink';
import type { PeerMessageEvent, Theme } from '../../../types.js';
import type { TierNode } from '../components/AgentTree.js';
import { clock, commsLine, type ActivityLog, type NodeActivity } from './activity.js';

export interface CascadeViewProps {
  root: TierNode | null;
  activity: ActivityLog;
  /** Bumped when the activity log changes, so the view redraws. */
  version: number;
  /** The node picked with ↑↓; null follows the busiest. */
  selectedId: string | null;
  width: number;
  /** Rows for the tree (and, side by side, the detail panel). */
  maxRows: number;
  theme: Theme;
  peerEvents: PeerMessageEvent[];
  showComms: boolean;
  now: number;
}

interface Row { node: TierNode; prefix: string; depth: number }

/** The tree, top to bottom, with its connectors. */
export function flatten(root: TierNode): Row[] {
  const rows: Row[] = [{ node: root, prefix: '', depth: 0 }];
  const walk = (node: TierNode, lead: string, depth: number) => {
    const kids = node.children ?? [];
    kids.forEach((child, i) => {
      const last = i === kids.length - 1;
      rows.push({ node: child, prefix: `${lead}${last ? '└─ ' : '├─ '}`, depth });
      walk(child, `${lead}${last ? '   ' : '│  '}`, depth + 1);
    });
  };
  walk(root, '', 1);
  return rows;
}

/** The node to show: the one picked, else the deepest that is working, else the root. */
export function focusOf(root: TierNode, selectedId: string | null, activity: ActivityLog): TierNode {
  const rows = flatten(root);
  if (selectedId) {
    const picked = rows.find((r) => r.node.id === selectedId);
    if (picked) return picked.node;
  }
  const active = rows.filter((r) => r.node.status === 'ACTIVE');
  if (!active.length) return root;
  // The deepest working node; among those, the one that did something last
  // (a worker still thinking about its first step is less to watch).
  const depth = Math.max(...active.map((r) => r.depth));
  const last = (id: string) => { const a = activity.get(id); return a?.lastAt ?? a?.startedAt ?? 0; };
  return active.filter((r) => r.depth === depth).sort((a, b) => last(b.node.id) - last(a.node.id))[0]!.node;
}

const strip = (label: string, role: string) => label.replace(new RegExp(`^\\[${role}\\]\\s*`, 'i'), '');

function glyph(status: TierNode['status'], theme: Theme, partial = false): { mark: string; color: string } {
  // Finished with part of its work done: still a tick (its work is used), in
  // the warning colour, with "partly" written beside it.
  if (status === 'COMPLETED' && partial) return { mark: '✔', color: theme.colors.warning };
  switch (status) {
    case 'ACTIVE': return { mark: '◐', color: theme.colors.warning };
    case 'COMPLETED': return { mark: '✔', color: theme.colors.success };
    case 'FAILED': return { mark: '✘', color: theme.colors.error };
    case 'ESCALATED': return { mark: '▲', color: theme.colors.warning };
    case 'BLOCKED': return { mark: '⤫', color: theme.colors.muted };
    default: return { mark: '○', color: theme.colors.muted };
  }
}

const roleColor = (role: TierNode['role'], theme: Theme) => (role === 'T1' ? theme.colors.t1Color : role === 'T2' ? theme.colors.t2Color : theme.colors.t3Color);

function elapsed(a: NodeActivity | undefined, status: TierNode['status'], now: number): string {
  if (!a?.startedAt) return status === 'IDLE' ? 'waiting' : '';
  return clock((a.endedAt ?? now) - a.startedAt);
}

function bar(done: number, total: number, cells = 8): string {
  if (!total) return '';
  const full = Math.round((done / total) * cells);
  return `${'█'.repeat(full)}${'░'.repeat(cells - full)} ${done}/${total}`;
}

const fit = (text: string, n: number): string => (n <= 0 ? '' : text.length > n ? `${text.slice(0, Math.max(0, n - 1))}…` : text.padEnd(n));

function TreeColumn({ root, rows, focus, width: columnWidth, maxRows, theme, activity, now, picked }: {
  root: TierNode; rows: Row[]; focus: TierNode; width: number; maxRows: number; theme: Theme; activity: ActivityLog; now: number; picked: boolean;
}): React.ReactElement {
  let width = columnWidth;
  // The T1 row stays on top; the rest scrolls to keep the focused row in view.
  const rest = rows.slice(1);
  const room = Math.max(1, maxRows - 1 - (rows.length > maxRows ? 1 : 0));
  const at = Math.max(0, rest.findIndex((r) => r.node === focus));
  const start = Math.min(Math.max(0, at - Math.floor(room / 2)), Math.max(0, rest.length - room));
  const shown = [rows[0]!, ...rest.slice(start, start + room)];
  const hidden = rest.length - room;
  width -= 1; // a space before the divider
  const sections = root.children ?? [];
  const done = sections.filter((c) => c.status === 'COMPLETED').length;
  return (
    <Box flexDirection="column" width={columnWidth}>
      {shown.map(({ node, prefix }) => {
        const g = glyph(node.status, theme, node.partial);
        const isFocus = node === focus;
        const time = elapsed(activity.get(node.id), node.status, now);
        if (node === root) {
          const progress = sections.length ? `  ${bar(done, sections.length)}` : '';
          const room = width - 5 - progress.length - 2;
          return (
            <Text key={node.id} wrap="truncate-end">
              <Text color={roleColor(node.role, theme)} bold>{node.role} </Text>
              <Text color={g.color}>{node.status === 'ACTIVE' ? '▸' : g.mark} </Text>
              <Text color={theme.colors.foreground} bold={isFocus}>{fit(strip(node.label, node.role), Math.max(8, room))}</Text>
              <Text color={theme.colors.accent}>{progress}</Text>
            </Text>
          );
        }
        const partly = node.status === 'COMPLETED' && node.partial ? ' partly' : '';
        const tail = `${partly}${time ? ` ${time}` : ''}${isFocus && picked ? ' ◀' : ''}`;
        const room = width - prefix.length - node.role.length - 3 - tail.length;
        return (
          <Text key={node.id} wrap="truncate-end">
            <Text color={theme.colors.muted}>{prefix}</Text>
            <Text color={roleColor(node.role, theme)}>{node.role} </Text>
            <Text color={g.color}>{g.mark} </Text>
            <Text color={isFocus ? theme.colors.foreground : node.status === 'COMPLETED' ? theme.colors.muted : theme.colors.foreground} bold={isFocus}>
              {fit(strip(node.label, node.role), Math.max(6, room))}
            </Text>
            {partly ? <Text color={theme.colors.warning}>{partly}</Text> : null}
            <Text color={theme.colors.muted}>{time ? ` ${time}` : ''}</Text>
            {isFocus && picked ? <Text color={theme.colors.primary}> ◀</Text> : null}
          </Text>
        );
      })}
      {hidden > 0 && <Text color={theme.colors.muted} dimColor>{`  ${hidden} more · ↑↓`}</Text>}
    </Box>
  );
}

function Detail({ node, activity, width, maxRows, theme, now, comms }: {
  node: TierNode; activity: NodeActivity | undefined; width: number; maxRows: number; theme: Theme; now: number; comms: string[];
}): React.ReactElement {
  const items = activity?.items ?? [];
  // Comms only where there is room left for what the node itself is doing.
  const commsRows = comms.length && maxRows >= 7 ? Math.min(2, comms.length) : 0;
  const room = Math.max(1, maxRows - 1 - (activity?.thought ? 1 : 0) - (commsRows ? commsRows + 1 : 0));
  const shown = items.slice(-room);
  const time = elapsed(activity, node.status, now);
  const toolW = Math.min(12, Math.max(6, ...shown.map((i) => i.tool.length + 1)));
  return (
    <Box flexDirection="column" width={width}>
      <Text wrap="truncate-end">
        <Text color={roleColor(node.role, theme)} bold>{node.role}</Text>
        <Text color={theme.colors.muted}> · </Text>
        <Text color={theme.colors.foreground} bold>{fit(strip(node.label, node.role), Math.max(6, width - node.role.length - 4 - time.length - 2))}</Text>
        <Text color={theme.colors.muted}>  {time}</Text>
      </Text>
      {activity?.thought ? <Text color={theme.colors.muted} italic wrap="truncate-end">∙ {activity.thought}</Text> : null}
      {!shown.length && !activity?.thought && (
        <Text color={theme.colors.muted} wrap="truncate-end">
          {node.status === 'ACTIVE' ? '∙ thinking…' : node.status === 'COMPLETED' ? '✔ done' : node.currentAction ?? 'waiting for its turn'}
        </Text>
      )}
      {shown.map((it, i) => {
        const mark = it.state === 'running' ? '◐' : it.state === 'failed' ? '✘' : '▸';
        const color = it.state === 'running' ? theme.colors.warning : it.state === 'failed' ? theme.colors.error : theme.colors.success;
        const note = it.note ? `  ${it.note}` : '';
        return (
          // The row's place too: a call id is the provider's, and not every provider makes them unique.
          <Text key={`${it.id}-${i}`} wrap="truncate-end">
            <Text color={color}>{mark} </Text>
            <Text color={theme.colors.secondary}>{it.tool.padEnd(toolW)}</Text>
            <Text color={theme.colors.foreground}>{fit(it.target, Math.max(4, width - toolW - 2 - note.length))}</Text>
            <Text color={it.state === 'failed' ? theme.colors.error : theme.colors.muted}>{note}</Text>
          </Text>
        );
      })}
      {commsRows > 0 && (
        <>
          <Text> </Text>
          {comms.slice(-commsRows).map((line, i) => (
            <Text key={i} wrap="truncate-end"><Text color={theme.colors.accent}>{i === 0 ? 'comms  ' : '       '}</Text><Text color={theme.colors.muted}>{line}</Text></Text>
          ))}
        </>
      )}
    </Box>
  );
}

function CascadeViewInternal({ root, activity, selectedId, width, maxRows, theme, peerEvents, showComms, now }: CascadeViewProps): React.ReactElement | null {
  if (!root) return null;
  const rows = flatten(root);
  const focus = focusOf(root, selectedId, activity);
  const names = new Map(rows.map((r) => [r.node.id, `${r.node.role}·${strip(r.node.label, r.node.role).split(/\s+/).slice(0, 2).join(' ')}`]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const comms = showComms ? peerEvents.slice(-4).map((ev) => commsLine(ev, nameOf)) : [];
  const picked = selectedId !== null && focus.id === selectedId;
  const sideBySide = width >= 110;
  if (sideBySide) {
    const left = Math.min(66, Math.floor(width * 0.5));
    const right = width - left - 4;
    const rowsHigh = Math.max(4, maxRows);
    return (
      <Box flexDirection="row" paddingX={1}>
        <TreeColumn root={root} rows={rows} focus={focus} width={left} maxRows={rowsHigh} theme={theme} activity={activity} now={now} picked={picked} />
        <Box borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor={theme.colors.border} paddingLeft={1}>
          <Detail node={focus} activity={activity.get(focus.id)} width={right} maxRows={rowsHigh} theme={theme} now={now} comms={comms} />
        </Box>
      </Box>
    );
  }
  // Narrow: the tree, then what the focused node is doing under it.
  const treeRows = Math.max(3, Math.ceil(maxRows * 0.5));
  return (
    <Box flexDirection="column" paddingX={1}>
      <TreeColumn root={root} rows={rows} focus={focus} width={width - 2} maxRows={treeRows} theme={theme} activity={activity} now={now} picked={picked} />
      <Box borderStyle="single" borderBottom={false} borderLeft={false} borderRight={false} borderColor={theme.colors.border}>
        <Detail node={focus} activity={activity.get(focus.id)} width={width - 2} maxRows={Math.max(3, maxRows - treeRows)} theme={theme} now={now} comms={comms} />
      </Box>
    </Box>
  );
}

export const CascadeView = React.memo(CascadeViewInternal);

/** The id of the node above or below `from` in the tree. */
export function stepSelection(root: TierNode, from: string | null, activity: ActivityLog, delta: 1 | -1): string {
  const rows = flatten(root);
  const current = focusOf(root, from, activity);
  const i = rows.findIndex((r) => r.node === current);
  return rows[Math.min(rows.length - 1, Math.max(0, i + delta))]!.node.id;
}
