import { Suspense, lazy, useEffect, useState } from 'react';
import App from './App.js';
import { NAVIGATE_EVENT, currentWhere, navigateTo, type Where } from './lib/nav.js';
import { isDocsPath } from './docs/route.js';

// The docs are their own chunk: the chat app never downloads them, and a docs
// visitor never starts the chat app (no session fetch, no socket).
const DocsApp = lazy(() => import('./docs/DocsApp.js'));

/**
 * What to show for the address. The app's own states (landing, chat) live in App;
 * the one URL-driven surface is /docs, which a signed-out visitor can read.
 */
export default function Root() {
  const [where, setWhere] = useState<Where>(currentWhere);
  useEffect(() => {
    const sync = () => setWhere(currentWhere());
    window.addEventListener('popstate', sync);
    window.addEventListener(NAVIGATE_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(NAVIGATE_EVENT, sync);
    };
  }, []);

  if (isDocsPath(where.pathname)) {
    return (
      <Suspense fallback={<div className="flex h-dvh items-center justify-center text-sm text-ink-400" role="status">Loading the docs…</div>}>
        <DocsApp pathname={where.pathname} hash={where.hash} onNavigate={navigateTo} />
      </Suspense>
    );
  }
  return <App />;
}
