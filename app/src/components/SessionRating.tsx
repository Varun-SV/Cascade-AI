import { useState } from 'react';
import type { Socket } from 'socket.io-client';
import { ThumbsUp, ThumbsDown, Check } from 'lucide-react';

interface Props {
  socket: Socket | null;
  sessionId: string | null;
}

export function SessionRating({ socket, sessionId }: Props) {
  const [rated, setRated] = useState<'good' | 'bad' | null>(null);

  if (!sessionId || !socket) return null;
  if (rated) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 11, color: 'var(--success)', padding: '6px 0', fontWeight: 600,
        animation: 'fadeIn 0.2s var(--ease)',
      }}>
        <Check size={13} />
        {rated === 'good' ? 'Rated good — routing boosted.' : 'Rated bad — routing will adapt.'}
      </div>
    );
  }

  const rate = (r: 'good' | 'bad') => {
    socket.emit('session:rate', { sessionId, rating: r });
    setRated(r);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Rate this session:</span>
      <RateButton onClick={() => rate('good')} title="Good result" hover="var(--success)" icon={<ThumbsUp size={13} />} />
      <RateButton onClick={() => rate('bad')} title="Poor result" hover="var(--danger)" icon={<ThumbsDown size={13} />} />
    </div>
  );
}

function RateButton({ onClick, title, hover, icon }: { onClick: () => void; title: string; hover: string; icon: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 26,
        background: 'var(--bg-raised)',
        border: '1px solid var(--border)',
        borderRadius: 6, cursor: 'pointer', color: 'var(--text-muted)',
        transition: 'color var(--dur), border-color var(--dur), background var(--dur)',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = hover; (e.currentTarget as HTMLElement).style.borderColor = hover; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; }}
    >
      {icon}
    </button>
  );
}
