// Injected first by the build: the device modules use Buffer as a global.
import { Buffer } from './buffer.js';

(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
