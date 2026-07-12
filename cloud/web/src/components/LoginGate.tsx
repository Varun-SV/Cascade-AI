import { useState } from 'react';
import { motion } from 'framer-motion';
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
    <div className="flex h-full items-center justify-center p-4">
      <motion.div
        className="glass-strong w-full max-w-sm rounded-3xl p-8 text-center"
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 24 }}
      >
        <motion.div
          className="accent-grad mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl shadow-xl shadow-accent-700/30"
          initial={{ rotate: -8, scale: 0.8 }}
          animate={{ rotate: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 18, delay: 0.05 }}
        >
          <Sparkles size={24} className="text-ink-950" />
        </motion.div>
        <h1 className="text-xl font-semibold text-ink-50">Sign in to Cascade Cloud</h1>
        <p className="mt-1 text-sm text-ink-400">Bring your own API keys — nothing is stored on our servers.</p>

        <div className="mt-6 flex flex-col gap-2">
          {config.githubEnabled && (
            <motion.a
              href="/auth/github"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-ink-100 hover:bg-white/[0.09]"
            >
              <Github size={16} /> Continue with GitHub
            </motion.a>
          )}
          {config.googleEnabled && (
            <motion.a
              href="/auth/google"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-ink-100 hover:bg-white/[0.09]"
            >
              Continue with Google
            </motion.a>
          )}
          {!config.githubEnabled && !config.googleEnabled && !config.devLoginEnabled && (
            <p className="text-xs text-ink-400">No sign-in methods are configured yet.</p>
          )}
        </div>

        {config.devLoginEnabled && (
          <div className="mt-6 border-t border-white/10 pt-4">
            <p className="mb-2 text-xs text-ink-400">Local development only</p>
            <div className="flex gap-2">
              <input
                className="flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-ink-100 outline-none focus:border-accent-500/60"
                placeholder="Your name"
                value={devName}
                onChange={(e) => setDevName(e.target.value)}
              />
              <motion.button
                type="button"
                disabled={busy}
                onClick={handleDevLogin}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.96 }}
                className="accent-grad rounded-lg px-3 py-1.5 text-sm font-semibold text-ink-950 shadow-lg shadow-accent-700/25 disabled:opacity-50"
              >
                Dev login
              </motion.button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
