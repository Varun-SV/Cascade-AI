import { useState } from 'react';
import { Github, Sparkles } from 'lucide-react';
import type { CloudConfig } from '../lib/api.js';
import { devLogin } from '../lib/api.js';

interface Props {
  config: CloudConfig;
  onDevLogin: () => void;
}

export default function LoginGate({ config, onDevLogin }: Props) {
  const [devName, setDevName] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleDevLogin() {
    setBusy(true);
    try {
      await devLogin(devName.trim() || 'Dev User');
      onDevLogin();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-cascade-950">
      <div className="w-full max-w-sm rounded-xl border border-cascade-800 bg-cascade-900/40 p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-cascade-600">
          <Sparkles size={22} className="text-white" />
        </div>
        <h1 className="text-xl font-semibold text-cascade-50">Sign in to Cascade Cloud</h1>
        <p className="mt-1 text-sm text-cascade-400">Bring your own API keys — nothing is stored on our servers.</p>

        <div className="mt-6 flex flex-col gap-2">
          {config.githubEnabled && (
            <a
              href="/auth/github"
              className="flex items-center justify-center gap-2 rounded-md bg-cascade-100 px-4 py-2 text-sm font-medium text-cascade-950 hover:bg-white"
            >
              <Github size={16} /> Continue with GitHub
            </a>
          )}
          {config.googleEnabled && (
            <a
              href="/auth/google"
              className="flex items-center justify-center gap-2 rounded-md border border-cascade-700 px-4 py-2 text-sm font-medium text-cascade-100 hover:bg-cascade-900"
            >
              Continue with Google
            </a>
          )}
          {!config.githubEnabled && !config.googleEnabled && !config.devLoginEnabled && (
            <p className="text-xs text-cascade-500">No sign-in methods are configured yet.</p>
          )}
        </div>

        {config.devLoginEnabled && (
          <div className="mt-6 border-t border-cascade-800 pt-4">
            <p className="mb-2 text-xs text-cascade-500">Local development only</p>
            <div className="flex gap-2">
              <input
                className="flex-1 rounded-md bg-cascade-950 px-3 py-1.5 text-sm text-cascade-100"
                placeholder="Your name"
                value={devName}
                onChange={(e) => setDevName(e.target.value)}
              />
              <button
                type="button"
                disabled={busy}
                onClick={handleDevLogin}
                className="rounded-md bg-cascade-700 px-3 py-1.5 text-sm text-white hover:bg-cascade-600 disabled:opacity-50"
              >
                Dev login
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
