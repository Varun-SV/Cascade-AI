import { useState } from 'react';
import type { Socket } from 'socket.io-client';

interface Props {
  socket: Socket | null;
  sessionId: string | null;
}

export function SessionRating({ socket, sessionId }: Props) {
  const [rated, setRated] = useState<'good' | 'bad' | null>(null);

  if (!sessionId || !socket) return null;
  if (rated) {
    return (
      <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '6px 0' }}>
        {rated === 'good' ? '✔ Rated good — routing boosted.' : '✔ Rated bad — routing will adapt.'}
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
      <button onClick={() => rate('good')} title="Good result" style={btnStyle}>👍</button>
      <button onClick={() => rate('bad')} title="Poor result" style={btnStyle}>👎</button>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: 'var(--bg-raised)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '3px 8px',
  cursor: 'pointer',
  fontSize: 14,
};
