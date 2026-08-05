import { describe, it, expect } from 'vitest';
import { BaseTier } from './base.js';
import type { TierRole } from '../../types.js';

/**
 * The task graph is only useful to a client if it survives the trip out.
 *
 * These tests exist because every field this event has ever gained had to be
 * added by hand at two separate emit sites with two different payload shapes,
 * and adding it to only one makes it arrive intermittently — which is harder
 * for a consumer to handle than a field that never arrives at all.
 */

class TestTier extends BaseTier {
  constructor(role: TierRole = 'T2') { super(role, 'T2_generated_id', 'T1_parent'); }
  // Both emit paths, exposed so each can be asserted independently.
  emitTerminal(): void { this.setStatus('COMPLETED'); }
  emitProgress(): void { this.sendStatusUpdate({ status: 'IN_PROGRESS', currentAction: 'working', progressPct: 50 }); }
}

function capture(fn: (t: TestTier) => void): Record<string, unknown> {
  const tier = new TestTier();
  tier.setGraphPosition({ nodeId: 's2', dependsOn: ['s1'], wave: 1 });
  let event: Record<string, unknown> = {};
  tier.on('tier:status', (e) => { event = e as Record<string, unknown>; });
  fn(tier);
  return event;
}

describe('graph position on tier:status', () => {
  it('rides on the terminal-status payload', () => {
    const e = capture((t) => t.emitTerminal());
    expect(e['nodeId']).toBe('s2');
    expect(e['dependsOn']).toEqual(['s1']);
    expect(e['waveId']).toBe(1);
  });

  it('rides on the progress-update payload too', () => {
    // The two payloads are built at different call sites. A consumer that saw
    // the graph fields only on completion could not draw the graph until the
    // run was over, which defeats the point of streaming it.
    const e = capture((t) => t.emitProgress());
    expect(e['nodeId']).toBe('s2');
    expect(e['dependsOn']).toEqual(['s1']);
    expect(e['waveId']).toBe(1);
  });

  it('keeps the graph id and the runtime tier id in separate fields', () => {
    // The whole reason nodeId exists: dependsOn names planner ids ("s1"),
    // while tierId is generated per construction. Collapsing them would make
    // every edge point at a node that never appears in the stream.
    const e = capture((t) => t.emitTerminal());
    expect(e['tierId']).toBe('T2_generated_id');
    expect(e['nodeId']).toBe('s2');
    expect(e['tierId']).not.toBe(e['nodeId']);
  });

  it('is absent rather than fabricated when nothing scheduled this tier', () => {
    // A directly-executed tier (Simple/Moderate routes) has no graph position.
    // Emitting a made-up one would put phantom nodes in a client's graph.
    const tier = new TestTier('T3');
    let event: Record<string, unknown> = {};
    tier.on('tier:status', (e) => { event = e as Record<string, unknown>; });
    tier.emitTerminal();
    expect(event['nodeId']).toBeUndefined();
    expect(event['dependsOn']).toBeUndefined();
    expect(event['waveId']).toBeUndefined();
  });

  it('lets the wave arrive after the id and edges, without clearing them', () => {
    // Identity is known at construction; the wave only when the scheduler
    // reaches the node. A setter that replaced the whole position would wipe
    // the edges at exactly that moment.
    const tier = new TestTier();
    tier.setGraphPosition({ nodeId: 's3', dependsOn: ['s1', 's2'] });
    tier.setGraphPosition({ wave: 2 });

    let event: Record<string, unknown> = {};
    tier.on('tier:status', (e) => { event = e as Record<string, unknown>; });
    tier.emitTerminal();

    expect(event['nodeId']).toBe('s3');
    expect(event['dependsOn']).toEqual(['s1', 's2']);
    expect(event['waveId']).toBe(2);
  });

  it('copies the edges, so a later mutation of the caller array cannot rewrite history', () => {
    const tier = new TestTier();
    const deps = ['s1'];
    tier.setGraphPosition({ nodeId: 's2', dependsOn: deps });
    deps.push('s9');

    let event: Record<string, unknown> = {};
    tier.on('tier:status', (e) => { event = e as Record<string, unknown>; });
    tier.emitTerminal();

    expect(event['dependsOn']).toEqual(['s1']);
  });
});
