/**
 * A one-line confirmation at the bottom of the screen ("Imported 3 chats",
 * "Copied"). Anything can raise one; <Toaster> in App shows the latest.
 */
export const TOAST_EVENT = 'cascade:toast';

export function toast(message: string): void {
  window.dispatchEvent(new CustomEvent<string>(TOAST_EVENT, { detail: message }));
}
