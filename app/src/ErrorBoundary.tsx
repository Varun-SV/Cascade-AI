import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State { hasError: boolean; message: string }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(err: unknown): State {
    return { hasError: true, message: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', err, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div style={{
        height: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 16,
        background: 'var(--bg-base)', color: 'var(--text)',
        fontFamily: 'var(--font-mono, monospace)',
      }}>
        <div style={{
          width: 60, height: 60, borderRadius: 'var(--radius-lg, 12px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--danger-soft, rgba(240,80,110,0.14))', color: 'var(--danger, #f0506e)', fontSize: 30,
        }}>⚠</div>
        <div style={{ fontWeight: 700, fontSize: 15 }}>Something went wrong</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 420, textAlign: 'center', lineHeight: 1.6 }}>
          {this.state.message || 'An unexpected error occurred in the renderer.'}
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            background: 'linear-gradient(135deg, var(--accent, #4c8dff), var(--accent-2, #2dd4bf))', border: 'none', borderRadius: 8,
            color: '#fff', padding: '9px 22px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            boxShadow: 'var(--shadow-1)',
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
