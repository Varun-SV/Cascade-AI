import React, { memo, useState } from 'react';

interface LoginViewProps {
  onLogin: (token: string) => void;
}

/**
 * LoginView — token entry form.
 *
 * The no-auth probe (checking if the server accepts an empty token) has been
 * moved to App.tsx so it runs once before this component is ever rendered.
 * This component is only shown when the server requires a real token.
 */
export const LoginView = memo(function LoginView({ onLogin }: LoginViewProps) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: token }),
      });
      if (res.ok) {
        const data = await res.json();
        onLogin(data.token);
      } else {
        setError('Invalid token — check your cascade dashboard config.');
      }
    } catch {
      setError('Cannot reach server. Is the dashboard running?');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex items-center justify-center w-full h-full bg-[var(--bg-base)] dot-grid overflow-hidden">
      {/* Ambient glow orbs */}
      <div className="absolute top-[20%] left-[30%] w-[480px] h-[480px] rounded-full bg-[var(--accent)] opacity-[0.035] blur-[140px] pointer-events-none" />
      <div className="absolute bottom-[20%] right-[25%] w-[320px] h-[320px] rounded-full bg-[var(--t3-color)] opacity-[0.03] blur-[120px] pointer-events-none" />

      <form
        onSubmit={handleSubmit}
        aria-label="Cascade AI login"
        className="
          relative z-10 w-full max-w-[360px]
          glass-elevated rounded-[var(--radius-lg)]
          p-8 shadow-dialog animate-fade-in-up
        "
      >
        {/* Brand */}
        <div className="flex items-center gap-3 mb-8">
          <div className="
            w-9 h-9 rounded-[var(--radius-sm)] bg-[var(--accent)]
            flex items-center justify-center flex-shrink-0
            shadow-[var(--shadow-glow-violet)]
          ">
            <span className="text-white font-black text-[14px] font-mono">C</span>
          </div>
          <div>
            <h1 className="text-[15px] font-bold text-[var(--text-primary)] tracking-tight">
              Cascade AI
            </h1>
            <p className="section-label mt-0.5">Dashboard</p>
          </div>
        </div>

        {/* Token input */}
        <div className="mb-5">
          <label
            htmlFor="token-input"
            className="block section-label mb-2"
          >
            Access Token
          </label>
          <input
            id="token-input"
            type="password"
            className="input"
            placeholder="paste your token here"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="current-password"
            autoFocus
          />
          {error && (
            <p role="alert" className="text-[11px] text-[var(--error)] mt-2 font-mono">
              {error}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={loading || !token.trim()}
          className="btn btn-primary w-full justify-center py-2.5"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full border border-white/40 border-t-white animate-spin" />
              Connecting…
            </span>
          ) : (
            'Connect'
          )}
        </button>

        <p className="text-center text-[10px] text-[var(--text-faint)] mt-5 font-mono">
          No token?{' '}
          <code className="text-[var(--text-muted)]">dashboard.auth: false</code>
        </p>
      </form>
    </div>
  );
});