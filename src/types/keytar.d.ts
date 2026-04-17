// Ambient declaration for the optional `keytar` native module.
// Included so `tsc --noEmit` and the tsup DTS build succeed on systems
// where keytar is not installed (e.g. Windows without build tools, Alpine,
// minimal CI images). At runtime `loadKeytar()` in src/config/keystore.ts
// uses a guarded dynamic import, so a missing module is handled gracefully.
declare module 'keytar' {
  export function getPassword(service: string, account: string): Promise<string | null>;
  export function setPassword(service: string, account: string, password: string): Promise<void>;
  export function deletePassword(service: string, account: string): Promise<boolean>;
  export function findCredentials(
    service: string,
  ): Promise<Array<{ account: string; password: string }>>;
  export function findPassword(service: string): Promise<string | null>;
}
