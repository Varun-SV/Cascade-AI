// ─────────────────────────────────────────────
//  Cascade AI — Open Web: which sources a query goes to
// ─────────────────────────────────────────────
//
//  General search always; Wikipedia always, weighted up for encyclopedic
//  questions; the specialist sources only when the query is theirs. Asking
//  arXiv about a recipe costs a request and adds nothing.

import type { EngineId } from './engines.js';

export interface Route {
  /** Each source asked, with the weight its ranks get when results are merged. */
  engines: Partial<Record<EngineId, number>>;
}

const has = (q: string, re: RegExp): boolean => re.test(q);

const CODE_WORDS = /\b(?:javascript|typescript|python|java|kotlin|swift|rust|golang|ruby|php|c\+\+|c#|csharp|scala|haskell|elixir|clojure|lua|perl|bash|shell|powershell|sql|postgres(?:ql)?|mysql|sqlite|mongodb|redis|react|vue|angular|svelte|next\.?js|node(?:\.?js)?|deno|bun|django|flask|fastapi|rails|spring|laravel|express|webpack|vite|docker|kubernetes|k8s|terraform|ansible|git|nginx|linux|regex|api|sdk|cli|json|yaml|css|html|dom|async|await|promise|compile|compiler|runtime|exception|traceback|stack ?trace|segfault|null ?pointer|undefined|typeerror|valueerror|keyerror|syntaxerror|importerror|modulenotfounderror|npm|pip|cargo|gradle|maven)\b/;
const CODE_SHAPES = /(?:\w\(\)|=>|::|\.(?:js|ts|tsx|py|rs|go|java|rb|php|cs|cpp|sh|yml|yaml|json|toml)\b|\berror:|\bE[0-9]{4}\b)/;

/** A camelCase or PascalCase identifier, such as `useEffect` or `ArrayList`: scanned, not matched. */
function hasCamelCase(text: string): boolean {
  for (const word of text.split(/[^A-Za-z]+/)) {
    if (word.length < 4) continue;
    for (let i = 1; i < word.length - 1; i++) {
      const c = word.charCodeAt(i);
      const prev = word.charCodeAt(i - 1);
      if (c >= 65 && c <= 90 && prev >= 97 && prev <= 122) return true;
    }
  }
  return false;
}
const REPO_WORDS = /\b(?:github|repo|repository|open[ -]source|library|libraries|framework|sdk|tool|alternative|alternatives|implementation|starter|template|boilerplate)\b/;
const PAPER_WORDS = /\b(?:paper|papers|arxiv|preprint|research|study|studies|survey|state[ -]of[ -]the[ -]art|sota|benchmark|dataset|transformer|llm|neural|diffusion|reinforcement learning|theorem|proof|et al)\b/;
const NPM_WORDS = /\b(?:npm|node(?:\.?js)?|javascript|typescript|react|vue|svelte|package\.json|yarn|pnpm)\b/;
const PY_WORDS = /\b(?:pypi|pip|python|django|flask|fastapi|pandas|numpy|conda|poetry)\b/;
const PACKAGE_WORDS = /\b(?:package|packages|library|libraries|module|install|dependency|version)\b/;
const HN_WORDS = /\b(?:hacker ?news|show hn|ask hn|\bhn\b|startup|startups|launch|launched|y ?combinator|yc)\b/;
const ENCYCLOPEDIC = /\b(?:who (?:is|was|were)|what (?:is|was|are)|history of|biography|born|died|capital of|population of|definition|meaning of|founded|invented|origin of)\b/;

/** The sources for a query, and how much each one's ranking counts. Exported for tests. */
export function route(raw: string): Route {
  const query = raw.slice(0, 500);
  const q = query.toLowerCase();
  const code = has(q, CODE_WORDS) || has(query, CODE_SHAPES) || hasCamelCase(query);
  const engines: Route['engines'] = {
    duckduckgo: 1,
    marginalia: 0.5,
    wikipedia: has(q, ENCYCLOPEDIC) ? 1.3 : code ? 0.4 : 0.8,
  };
  if (code) engines.stackoverflow = 1.1;
  if (has(q, REPO_WORDS) || (code && has(q, /\b(?:library|framework|tool|repo)\b/))) engines.github = 1;
  if (has(q, PAPER_WORDS)) engines.arxiv = 1.1;
  if (has(q, HN_WORDS)) engines.hackernews = 1;
  if (has(q, PACKAGE_WORDS) || has(q, /\bnpm\b|\bpypi\b|\bpip install\b/)) {
    if (has(q, NPM_WORDS)) engines.npm = 1;
    if (has(q, PY_WORDS)) engines.pypi = 1.1;
    if (!has(q, NPM_WORDS) && !has(q, PY_WORDS)) { engines.npm = 0.7; engines.pypi = 0.7; }
  }
  return { engines };
}
