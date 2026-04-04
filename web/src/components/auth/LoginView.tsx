import React, { useState } from 'react';
import { Network, Zap, ShieldCheck } from 'lucide-react';

interface LoginViewProps {
  onLogin: (token: string) => void;
  vibe: 'hacker' | 'linear';
  setVibe: (v: 'hacker' | 'linear') => void;
}

export function LoginView({ onLogin, vibe, setVibe }: LoginViewProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const isHacker = vibe === 'hacker';

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password }),
      });

      if (response.ok) {
        const { token } = await response.json() as { token: string };
        localStorage.setItem('cascade_token', token);
        onLogin(token);
      } else {
        setError('ACCESS DENIED. INVALID CREDENTIALS.');
      }
    } catch {
      setError('CONNECTION FAILURE. ENGINE OFFLINE.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`min-h-screen flex items-center justify-center transition-colors duration-500 overflow-hidden relative ${
      isHacker ? 'bg-black' : 'bg-slate-950'
    }`}>
      {/* Background Ambient Glows */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full blur-[120px] opacity-20 bg-blue-600 animate-pulse" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] rounded-full blur-[120px] opacity-20 bg-purple-600" />

      {/* Vibe Toggle */}
      <button 
        onClick={() => setVibe(isHacker ? 'linear' : 'hacker')}
        className="absolute top-8 right-8 flex items-center gap-2 text-xs uppercase tracking-widest text-slate-400 hover:text-white transition-colors duration-300 z-50 group"
      >
        <Zap className={`w-4 h-4 transition-transform group-hover:scale-110 ${isHacker ? 'text-green-500' : 'text-blue-500'}`} />
        <span>Vibe: {vibe}</span>
      </button>

      {/* Login Box */}
      <div className={`relative w-full max-w-md p-10 backdrop-blur-xl border transition-all duration-500 ${
        isHacker 
          ? 'bg-black/40 border-green-500/30' 
          : 'bg-white/5 border-white/10 rounded-3xl shadow-2xl'
      }`}>
        <div className="text-center mb-10">
          <div className="relative inline-block mb-6">
            <Network className={`w-16 h-16 mx-auto ${
              isHacker ? 'text-green-500 animate-pulse' : 'text-blue-500'
            }`} />
            {!isHacker && <div className="absolute inset-0 blur-xl opacity-50 bg-blue-500 rounded-full -z-10" />}
          </div>
          <h1 className={`text-3xl font-bold tracking-[0.2em] uppercase mb-2 ${
            isHacker ? 'text-green-500 font-mono' : 'text-white'
          }`}>
            Cascade
          </h1>
          <p className={`text-[10px] uppercase tracking-[0.4em] opacity-50 ${isHacker ? 'text-green-400' : 'text-slate-400'}`}>
            Autonomous Orchestration Engine
          </p>
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
          <div className="space-y-1">
            <div className="relative group">
              <input 
                type="password" 
                placeholder="ACCESS KEY" 
                value={password}
                onChange={e => setPassword(e.target.value)}
                disabled={loading}
                className={`w-full px-6 py-4 outline-none transition-all duration-300 text-center tracking-widest ${
                  isHacker 
                    ? 'bg-black border border-green-500/50 text-green-500 placeholder:text-green-500/20 focus:border-green-400 focus:shadow-[0_0_15px_rgba(0,255,0,0.1)] font-mono'
                    : 'bg-slate-900/50 border border-white/10 rounded-2xl text-white placeholder:text-slate-600 focus:border-blue-500/50 focus:bg-slate-900/80'
                }`}
              />
              <ShieldCheck className={`absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 opacity-30 group-focus-within:opacity-100 transition-opacity ${
                isHacker ? 'text-green-500' : 'text-blue-500'
              }`} />
            </div>
          </div>

          {error && (
            <div className={`text-[10px] text-center font-bold tracking-widest border py-2 animate-bounce ${
              isHacker ? 'border-red-500/30 text-red-500 bg-red-500/5' : 'border-red-400/20 text-red-400'
            }`}>
              {error}
            </div>
          )}

          <button 
            type="submit" 
            disabled={loading || !password}
            className={`w-full py-4 font-black tracking-[0.3em] uppercase transition-all duration-300 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed ${
              isHacker 
                ? 'bg-green-600/10 border border-green-500 text-green-500 hover:bg-green-600/20 shadow-[0_0_20px_rgba(34,197,94,0.1)]'
                : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-2xl shadow-lg'
            }`}
          >
            {loading ? 'Decrypting...' : 'Initialize'}
          </button>
        </form>

        <div className="mt-10 pt-6 border-t border-white/5 text-center">
          <p className="text-[9px] uppercase tracking-widest opacity-20 text-slate-400">
            Secure Terminal Link Established
          </p>
        </div>
      </div>
    </div>
  );
}
