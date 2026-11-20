// The categories a memory is kept under: the same six the builder sorts into
// (core/knowledge/memory-builder.ts). A memory saved before categories were
// fixed keeps its own label and is shown under "Other".

export const MEMORY_CATEGORIES = [
  { id: 'about-you', label: 'About you', hint: 'Who you are: work, background, where you are' },
  { id: 'preferences', label: 'Preferences', hint: 'How you like things done and answered' },
  { id: 'projects', label: 'Projects & work', hint: 'What you are building or working on' },
  { id: 'goals', label: 'Goals', hint: 'What you are working towards' },
  { id: 'instructions', label: 'Instructions', hint: 'Standing rules for how Cascade should behave' },
  { id: 'facts', label: 'Facts', hint: 'Other things worth knowing' },
] as const;

export type MemoryCategoryId = (typeof MEMORY_CATEGORIES)[number]['id'];

const IDS = new Set<string>(MEMORY_CATEGORIES.map((c) => c.id));

/** The group a memory is shown in: its category when it is one of the six, else "other". */
export function groupOf(category: string | null | undefined): MemoryCategoryId | 'other' {
  return category && IDS.has(category) ? (category as MemoryCategoryId) : 'other';
}

export function labelOf(group: MemoryCategoryId | 'other'): string {
  return MEMORY_CATEGORIES.find((c) => c.id === group)?.label ?? 'Other';
}
