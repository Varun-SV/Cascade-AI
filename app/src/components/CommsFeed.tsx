import { useEffect, useRef } from 'react';
import { Radio, ArrowRight, Megaphone, Lock, Milestone, MessageSquareShare } from 'lucide-react';
import { useAppSelector } from '../store/index.js';

/** Visual metadata per PeerBus sync type (see src/types.ts PeerSyncType). */
const SYNC_META: Record<string, { label: string; icon: typeof Radio; color: string }> = {
  SHARE_OUTPUT:     { label: 'share',     icon: MessageSquareShare, color: 'var(--t3)' },
  RESOLVE_CONFLICT: { label: 'conflict',  icon: Milestone,          color: 'var(--warn)' },
  DIVIDE_WORK:      { label: 'divide',    icon: ArrowRight,         color: 'var(--t2)' },
  BROADCAST:        { label: 'broadcast', icon: Megaphone,          color: 'var(--accent)' },
  FILE_LOCK:        { label: 'file lock', icon: Lock,               color: 'var(--danger)' },
  BARRIER:          { label: 'barrier',   icon: Milestone,          color: 'var(--t1)' },
  STEER:            { label: 'steer',     icon: Megaphone,          color: 'var(--warn)' },
};

function fmtTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** Shorten worker ids like `t3-worker-abc123-2` for the feed's columns. */
function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 15)}…` : id;
}

/**
 * The desktop's `/comms`: a live ticker of agent-to-agent PeerBus traffic —
 * peer messages, broadcasts, file locks, barrier syncs — plus user steering
 * injections. Events accumulate in the store (App.tsx `peer:message` /
 * `session:message-injected` handlers) so the feed survives tab switches.
 */
export function CommsFeed() {
  const events = useAppSelector((s) => s.app.commsEvents);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  if (events.length === 0) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: 'var(--text-dim)' }}>
        <Radio size={22} style={{ opacity: 0.5 }} />
        <div style={{ fontSize: 12 }}>No agent chatter yet — comms appear here while workers coordinate.</div>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '6px 0', fontFamily: 'var(--font-mono)' }}>
      {events.map((e) => {
        const meta = SYNC_META[e.syncType] ?? { label: e.syncType.toLowerCase(), icon: Radio, color: 'var(--text-muted)' };
        const Icon = meta.icon;
        return (
          <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 12px', fontSize: 11, lineHeight: 1.6 }}>
            <span style={{ color: 'var(--text-dim)', flexShrink: 0 }}>{fmtTime(e.at)}</span>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
              color: meta.color, fontWeight: 700, fontSize: 9.5, letterSpacing: 0.5, textTransform: 'uppercase',
              padding: '0 6px', borderRadius: 3, background: `color-mix(in srgb, ${meta.color} 12%, transparent)`,
              minWidth: 74, justifyContent: 'center',
            }}><Icon size={9} /> {meta.label}</span>
            <span style={{ color: 'var(--t3)', flexShrink: 0 }}>{shortId(e.fromId)}</span>
            <ArrowRight size={9} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
            <span style={{ color: e.toId ? 'var(--t3)' : 'var(--accent)', flexShrink: 0 }}>{e.toId ? shortId(e.toId) : 'ALL'}</span>
            {e.payload && (
              <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.payload}
              </span>
            )}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
