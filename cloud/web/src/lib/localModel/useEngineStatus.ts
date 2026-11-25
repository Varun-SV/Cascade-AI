import { useSyncExternalStore } from 'react';
import { getEngineStatus, subscribeEngineStatus, type EngineStatus } from './engine.js';

/** The page's on-device model status, kept current. Cheap: no import of the model library. */
export function useEngineStatus(): EngineStatus {
  return useSyncExternalStore(subscribeEngineStatus, getEngineStatus, getEngineStatus);
}
