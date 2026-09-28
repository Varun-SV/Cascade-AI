import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
// Self-hosted type (no third-party font requests): Geist for the interface,
// Source Serif 4 for reading, Geist Mono for receipts and code.
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/source-serif-4';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
