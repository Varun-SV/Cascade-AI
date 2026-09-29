import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Stacking is CSS, which jsdom doesn't lay out, so this reads the layers where
// they are declared.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const layer = (source: string, pattern: RegExp) => Number(pattern.exec(source)?.[1]);

describe('Menu layer', () => {
  it('opens above the phone drawer and ordinary windows, below the prompts a run waits on', () => {
    const menu = layer(read('../index.css'), /\.cz-menu \{[^}]*?\bz-\[(\d+)\]/);
    const modal = layer(read('./Modal.tsx'), /zIndexClassName = 'z-(\d+)'/);
    const context = layer(read('../chat/ContextApprovalDialog.tsx'), /fixed inset-0 z-(\d+)/);
    const escalation = layer(read('../chat/EscalationModal.tsx'), /zIndexClassName="z-\[(\d+)\]"/);
    expect([menu, modal, context, escalation].every(Number.isFinite)).toBe(true);
    expect(menu).toBeGreaterThan(modal);
    expect(menu).toBeLessThan(context);
    expect(menu).toBeLessThan(escalation);
  });
});
