import 'react';

// Electron's `-webkit-app-region` drag region property isn't in React's
// CSSProperties by default — declare it so the custom title bar can use it.
declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag';
  }
}
