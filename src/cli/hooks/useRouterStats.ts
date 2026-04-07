import { useState, useEffect } from 'react';
import type { RouterStats } from '../../core/router/index.js';
import type { CascadeRouter } from '../../core/router/index.js';

export function useRouterStats(router: CascadeRouter, intervalMs = 1000): RouterStats {
  const [stats, setStats] = useState<RouterStats>(router.getStats());

  useEffect(() => {
    const id = setInterval(() => {
      setStats(router.getStats());
    }, intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);

  return stats;
}