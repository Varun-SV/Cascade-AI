import type { DocPage, DocSection } from './types.js';
import { GETTING_STARTED } from './getting-started.js';
import { USING } from './using.js';
import { COMPUTER } from './computer.js';
import { CLI_REFERENCE } from './cli-reference.js';
import { CONFIGURATION } from './configuration.js';
import { SELFHOST } from './selfhost.js';
import { HELP } from './help.js';

export type { Block, DocPage, DocSection } from './types.js';
export { CHANGELOG_URL } from './help.js';

/** Sidebar order. A page's `section` is one of these ids. */
export const SECTIONS: DocSection[] = [
  { id: 'getting-started', title: 'Getting started', blurb: 'What Cascade is, and the quickest way to use it on each surface.' },
  { id: 'using', title: 'Using Cascade', blurb: 'Keys, routing, search, files, memory, connectors and spend.' },
  { id: 'computer', title: 'Your computer', blurb: 'Let a run work in your folder or your browser, with undo and a jail.' },
  { id: 'cli-reference', title: 'CLI reference', blurb: 'Commands, slash commands, the settings panel, keys and approvals.' },
  { id: 'configuration', title: 'Configuration', blurb: 'The config file, .cascadeignore and environment variables.' },
  { id: 'self-hosting', title: 'Self-hosting', blurb: 'Run your own server with Docker, and what every variable does.' },
  { id: 'help', title: 'Help', blurb: 'FAQ, troubleshooting, privacy and the changelog.' },
];

/** Every page, in reading order: section by section, as the sidebar lists them. */
export const PAGES: DocPage[] = [
  ...GETTING_STARTED,
  ...USING,
  ...COMPUTER,
  ...CLI_REFERENCE,
  ...CONFIGURATION,
  ...SELFHOST,
  ...HELP,
];

export const SLUGS: ReadonlySet<string> = new Set(PAGES.map((p) => p.slug));

export const pageBySlug = (slug: string): DocPage | undefined => PAGES.find((p) => p.slug === slug);

export const sectionById = (id: string): DocSection | undefined => SECTIONS.find((s) => s.id === id);

export const pagesIn = (sectionId: string): DocPage[] => PAGES.filter((p) => p.section === sectionId);

/** The pages either side of a page, in reading order. */
export function neighbours(slug: string): { prev: DocPage | null; next: DocPage | null } {
  const i = PAGES.findIndex((p) => p.slug === slug);
  return { prev: i > 0 ? PAGES[i - 1]! : null, next: i >= 0 && i < PAGES.length - 1 ? PAGES[i + 1]! : null };
}
