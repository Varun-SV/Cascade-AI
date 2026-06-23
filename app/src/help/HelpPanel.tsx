import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../store/index.js';
import { setHelpContext } from '../store/index.js';
import type { TourStep } from './types.js';
import { VideoPlayer } from './VideoPlayer.js';
import { AnimatedTour } from './AnimatedTour.js';
import { WalkthroughEngine } from './WalkthroughEngine.js';
import { DocsViewer } from './DocsViewer.js';
import * as providerSetup from './tutorials/provider-setup.js';
import * as howTiersWork from './tutorials/how-tiers-work.js';
import * as firstTask from './tutorials/first-task.js';
import * as costAnalytics from './tutorials/cost-analytics.js';

type Tab = 'watch' | 'tour' | 'docs';

// Shared shape of every tutorial module. Typing the map against this (rather than
// `typeof providerSetup`) avoids a structural mismatch on the literal `docs`
// string type between modules.
interface TutorialModule { VIDEO_ID: string; steps: TourStep[]; docs: string }

const CONTEXT_MAP: Record<string, { title: string; module: TutorialModule }> = {
  'provider-setup': { title: 'Provider Setup', module: providerSetup },
  'how-tiers-work': { title: 'How Tiers Work', module: howTiersWork },
  cockpit: { title: 'Running Your First Task', module: firstTask },
  chat: { title: 'Running Your First Task', module: firstTask },
  code: { title: 'Running Your First Task', module: firstTask },
  'cost-analytics': { title: 'Cost & Analytics', module: costAnalytics },
  default: { title: 'Getting Started', module: firstTask },
};

export function HelpPanel() {
  const dispatch = useAppDispatch();
  const context = useAppSelector((s) => s.app.helpContext);
  const [tab, setTab] = useState<Tab>('watch');
  const close = () => dispatch(setHelpContext(null));

  // Dismiss path #2: Escape closes the panel from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!context) return null;

  const { title, module } = CONTEXT_MAP[context] ?? CONTEXT_MAP.default;

  const TABS: { id: Tab; label: string }[] = [
    { id: 'watch', label: 'Watch' },
    { id: 'tour', label: 'Tour' },
    { id: 'docs', label: 'Docs' },
  ];

  return (
    <>
      {/* Dismiss path #3: click anywhere outside the panel. Transparent (no dim)
          so the docked tool-window feel is preserved. */}
      <div onClick={close} style={{ position: 'absolute', inset: 0, zIndex: 499 }} />
    <div style={{
      position: 'absolute', top: 0, right: 0, bottom: 0, width: 360,
      background: 'var(--bg-surface)', borderLeft: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', zIndex: 500,
      boxShadow: 'var(--shadow-2)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', padding: '10px 16px',
        borderBottom: '1px solid var(--border)', gap: 8, flexShrink: 0,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>Help</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{title}</div>
        </div>
        <button
          onClick={close}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', padding: 4, borderRadius: 4 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'; }}
        >
          <X size={16} />
        </button>
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0,
        padding: '0 16px',
      }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '8px 14px', fontSize: 12, fontWeight: tab === t.id ? 600 : 400,
              color: tab === t.id ? 'var(--accent)' : 'var(--text-muted)',
              background: 'transparent', border: 'none', cursor: 'pointer',
              borderBottom: tab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {tab === 'watch' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* A rendered video takes precedence once a VIDEO_ID is populated;
                until then, play the in-app animated walkthrough of the steps. */}
            {module.VIDEO_ID
              ? <VideoPlayer projectId={module.VIDEO_ID} title={title} />
              : <AnimatedTour steps={module.steps} title={title} />}
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, lineHeight: 1.6 }}>
              This animated walkthrough covers the key concepts. Switch to the
              Tour tab for an interactive, click-through guide on the live UI, or
              Docs for the full reference.
            </p>
          </div>
        )}
        {tab === 'tour' && (
          <WalkthroughEngine steps={module.steps} context={title} />
        )}
        {tab === 'docs' && (
          <DocsViewer content={module.docs} />
        )}
      </div>

      {/* Quick links footer */}
      <div style={{
        borderTop: '1px solid var(--border)', padding: '8px 16px',
        display: 'flex', gap: 12, flexShrink: 0,
      }}>
        {[
          { label: 'Provider Setup', ctx: 'provider-setup' },
          { label: 'Tiers', ctx: 'how-tiers-work' },
          { label: 'Cost', ctx: 'cost-analytics' },
        ].filter((l) => l.ctx !== context).slice(0, 2).map((link) => (
          <button
            key={link.ctx}
            onClick={() => dispatch(setHelpContext(link.ctx))}
            style={{
              fontSize: 11, color: 'var(--accent)', background: 'transparent',
              border: 'none', cursor: 'pointer', padding: 0,
            }}
          >
            {link.label} →
          </button>
        ))}
      </div>
    </div>
    </>
  );
}
