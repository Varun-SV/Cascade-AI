import React, { memo, useState, useEffect } from 'react';

interface LoginViewProps {
  onLogin: (token: string) => void;
}

export const LoginView = memo(function LoginView({ onLogin }: LoginViewProps) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Try no-auth access immediately
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/runtime?scope=workspace', {
          headers: { Authorization: 'Bearer ' },
        });
        if (res.ok) onLogin('');
      } catch {
        // needs auth or server not ready
      }
    })();
  }, [onLogin]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/runtime?scope=workspace', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        onLogin(token);
      } else {
        setError('Invalid token. Check cascade dashboard config.');
      }
    } catch {
      setError('Cannot reach server. Is the dashboard running?');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center w-full h-full dot-grid">
      {/* Ambient glow orbs */}
      <div className="absolute top-1/4 left-1/3 w-96 h-96 rounded-full
                      bg-[var(--accent)] opacity-[0.04] blur-[120px] pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/3 w-64 h-64 rounded-full
                      bg-[var(--t3-color)] opacity-[0.04] blur-[100px] pointer-events-none" />

      <form
        onSubmit={handleSubmit}
        className="relative w-full max-w-sm glass-elevated rounded-[var(--radius-xl)]
                   p-8 shadow-dialog animate-fade-in-up"
        aria-label="Cascade AI login"
      >
        {/* Logo */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-[var(--radius-md)] bg-[var(--accent)]
                          flex items-center justify-center shadow-[var(--shadow-glow-violet)]">
            <span className="text-white font-black text-lg">C</span>
          </div>
          <div>
            <h1 className="text-[16px] font-bold text-[var(--text-primary)]">Cascade AI</h1>
            <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Dashboard</p>
          </div>
        </div>

        <div className="mb-6">
          <label htmlFor="token-input" className="block text-[11px] text-[var(--text-muted)] mb-2 uppercase tracking-wider">
            Access Token
          </label>
          <input
            id="token-input"
            type="password"
            className="input font-mono"
            placeholder="paste your token here"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="current-password"
          />
          {error && (
            <p role="alert" className="text-[11px] text-[var(--error)] mt-2">
              {error}
            </p>
          )}
        </div>

        <button
          type="submit"
          id="login-btn"
          disabled={loading}
          className="btn btn-primary w-full justify-center py-2.5 text-[13px]"
        >
          {loading ? 'Connecting…' : 'Connect to Dashboard'}
        </button>

        <p className="text-center text-[10px] text-[var(--text-faint)] mt-5">
          No token? Set <code className="font-mono text-[var(--text-muted)]">dashboard.auth: false</code> in config
        </p>
      </form>
    </div>
  );
});
