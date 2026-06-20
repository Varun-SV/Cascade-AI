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
        <div style={{ fontSize: 32 }}>⚠</div>
        <div style={{ fontWeight: 600 }}>Something went wrong</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 400, textAlign: 'center' }}>
          {this.state.message || 'An unexpected error occurred in the renderer.'}
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            background: 'var(--accent)', border: 'none', borderRadius: 6,
            color: '#fff', padding: '8px 20px', fontSize: 13, cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
