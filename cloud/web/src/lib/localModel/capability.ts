// Decides whether this device can run the opt-in in-browser title model.
// Kept a pure function of a Navigator-like object so it's unit-testable.

export interface LocalModelCapability {
  supported: boolean;
  reason: string;
}

interface NavLike {
  gpu?: unknown;
  deviceMemory?: number;
}

/** Minimum reported RAM (GB) we require before offering the local model.
 *  navigator.deviceMemory is coarse (0.25/0.5/1/2/4/8) and capped at 8. */
const MIN_DEVICE_MEMORY_GB = 4;

export function detectLocalModelCapability(nav?: NavLike): LocalModelCapability {
  const n = nav ?? (typeof navigator !== 'undefined' ? (navigator as unknown as NavLike) : undefined);
  if (!n) return { supported: false, reason: 'No browser environment' };
  // WebGPU is the hard requirement — WebLLM runs the model on the GPU.
  if (!n.gpu) return { supported: false, reason: 'This browser has no WebGPU (try a recent Chrome, Edge, or Safari on desktop)' };
  // deviceMemory is Chrome-only; when present and clearly low, don't offer it.
  if (typeof n.deviceMemory === 'number' && n.deviceMemory > 0 && n.deviceMemory < MIN_DEVICE_MEMORY_GB) {
    return { supported: false, reason: `Needs ~${MIN_DEVICE_MEMORY_GB}GB+ RAM (this device reports ~${n.deviceMemory}GB)` };
  }
  return { supported: true, reason: 'WebGPU available' };
}
