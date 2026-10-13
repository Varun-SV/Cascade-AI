import { describe, it, expect } from 'vitest';
import {
  emptyRecord,
  isSuspended,
  recordStrike,
  recentStrikeCount,
  clearSuspension,
  type AbuseRecord,
  type AbusePolicy,
} from './abuse-ledger.js';

const policy: AbusePolicy = { windowMs: 1000, threshold: 3 };

function strikeAt(at: number, code = 'host-rate') {
  return { at, code };
}

describe('recordStrike', () => {
  it('does not suspend below the threshold', () => {
    let rec = emptyRecord();
    let r = recordStrike(rec, strikeAt(100), policy);
    expect(r.nowSuspended).toBe(false);
    rec = r.record;
    r = recordStrike(rec, strikeAt(200), policy);
    expect(r.nowSuspended).toBe(false);
    expect(isSuspended(r.record)).toBe(false);
  });

  it('suspends on the Nth strike within the window', () => {
    let rec = emptyRecord();
    rec = recordStrike(rec, strikeAt(100), policy).record;
    rec = recordStrike(rec, strikeAt(200), policy).record;
    const r = recordStrike(rec, strikeAt(300, 'host-spread'), policy);
    expect(r.nowSuspended).toBe(true);
    expect(isSuspended(r.record)).toBe(true);
    expect(r.record.suspendedFor).toBe('host-spread');
    expect(r.record.suspendedAt).toBe(300);
  });

  it('does not fire a second suspension for an already-suspended user', () => {
    let rec = emptyRecord();
    rec = recordStrike(rec, strikeAt(100), policy).record;
    rec = recordStrike(rec, strikeAt(200), policy).record;
    rec = recordStrike(rec, strikeAt(300), policy).record; // suspends
    const r = recordStrike(rec, strikeAt(400), policy);
    expect(r.nowSuspended).toBe(false); // still suspended, no new notice
    expect(isSuspended(r.record)).toBe(true);
    expect(r.record.strikes.length).toBe(4); // but the strike is still recorded as evidence
  });

  it('forgets strikes older than the window so a slow drip does not suspend', () => {
    let rec = emptyRecord();
    rec = recordStrike(rec, strikeAt(0), policy).record;
    rec = recordStrike(rec, strikeAt(950), policy).record;
    // At 2000ms (window 1000), both earlier strikes are outside (gap > 1000);
    // only the new one stands, so three slow strikes never meet the threshold.
    const r = recordStrike(rec, strikeAt(2000), policy);
    expect(r.nowSuspended).toBe(false);
    expect(recentStrikeCount(r.record, 2000, policy)).toBe(1); // only 2000
  });

  it('a suspension set while strikes were fresh persists after they age out', () => {
    let rec = emptyRecord();
    rec = recordStrike(rec, strikeAt(100), policy).record;
    rec = recordStrike(rec, strikeAt(200), policy).record;
    rec = recordStrike(rec, strikeAt(300), policy).record; // suspends at 300
    expect(isSuspended(rec)).toBe(true);
    // Long after the window, still suspended — only a person clears it.
    const r = recordStrike(rec, strikeAt(10_000), policy);
    expect(isSuspended(r.record)).toBe(true);
  });
});

describe('clearSuspension', () => {
  it('lifts the flag and resets history', () => {
    let rec: AbuseRecord = emptyRecord();
    rec = recordStrike(rec, strikeAt(100), policy).record;
    rec = recordStrike(rec, strikeAt(200), policy).record;
    rec = recordStrike(rec, strikeAt(300), policy).record;
    expect(isSuspended(rec)).toBe(true);
    const cleared = clearSuspension(rec);
    expect(isSuspended(cleared)).toBe(false);
    expect(cleared.strikes.length).toBe(0);
    // And they start clean, not one strike from the wall.
    const r = recordStrike(cleared, strikeAt(400), policy);
    expect(r.nowSuspended).toBe(false);
  });
});

describe('recentStrikeCount', () => {
  it('counts only strikes within the window', () => {
    let rec = emptyRecord();
    rec = recordStrike(rec, strikeAt(0), policy).record;
    rec = recordStrike(rec, strikeAt(500), policy).record;
    expect(recentStrikeCount(rec, 900, policy)).toBe(2);
    expect(recentStrikeCount(rec, 1200, policy)).toBe(1); // 0 aged out
  });
});
