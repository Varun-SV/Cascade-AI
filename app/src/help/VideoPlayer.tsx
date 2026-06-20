import { PlayCircle } from 'lucide-react';

interface Props { projectId: string; title?: string }

export function VideoPlayer({ projectId, title }: Props) {
  if (!projectId) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: 220, gap: 12, color: 'var(--text-muted)',
        background: 'var(--bg-base)', borderRadius: 8, border: '1px dashed var(--border)',
      }}>
        <PlayCircle size={40} style={{ opacity: 0.3 }} />
        <span style={{ fontSize: 12 }}>Tutorial video coming soon</span>
      </div>
    );
  }

  return (
    <div style={{ borderRadius: 8, overflow: 'hidden', background: '#000', aspectRatio: '16/9', position: 'relative' }}>
      <iframe
        src={`https://app.heygen.com/projects/${projectId}`}
        title={title ?? 'Tutorial'}
        allow="autoplay; encrypted-media; fullscreen"
        sandbox="allow-scripts allow-same-origin allow-presentation"
        style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
      />
    </div>
  );
}
