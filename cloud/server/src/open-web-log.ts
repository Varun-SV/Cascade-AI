// ─────────────────────────────────────────────
//  Cascade Cloud — a line in the server's log for each free web search
// ─────────────────────────────────────────────
//
//  Which sources answered and how many results there were, so a search that
//  went wrong can be told apart from one that found nothing. Never the query,
//  a result's address, or anything else that says what a person searched for:
//  the SDK's summary carries none of it, and this adds none.

import { onOpenWebSearch, type OpenWebSummary } from '#cascade-ai';

/** The summary as one log line. Exported for tests. */
export function describeOpenWebSearch(s: OpenWebSummary): string {
  const sources = s.sources
    .map((x) => (x.outcome === 'answered' ? `${x.engine} answered ${x.found}` : `${x.engine} ${x.outcome}`))
    .join(', ');
  return `[open-web] ${s.results} result${s.results === 1 ? '' : 's'} in ${s.ms} ms${s.retried ? ' (retried with fewer words)' : ''}; ${sources || 'no sources asked'}`;
}

/** Logs each search from now on; returns the way to stop. */
export function logOpenWebSearches(log: (line: string) => void = (line) => console.log(line)): () => void {
  return onOpenWebSearch((s) => log(describeOpenWebSearch(s)));
}
