import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface Props { cwd?: string }

// Read a design token from the document so the terminal follows the app theme.
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function buildTermTheme() {
  const bg = cssVar('--bg-base', '#1b1c1e');
  return {
    background: bg,
    foreground: cssVar('--text', '#e7e8ea'),
    cursor: cssVar('--accent', '#4f8cff'),
    cursorAccent: bg,
    selectionBackground: cssVar('--accent-soft', 'rgba(79,140,255,0.16)'),
  };
}

export function TerminalPanel({ cwd }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: buildTermTheme(),
      fontFamily: '"JetBrains Mono", "Cascadia Code", monospace',
      fontSize: 13,
      cursorBlink: true,
    });

    // Re-theme the terminal live when the app switches light/dark.
    const themeObserver = new MutationObserver(() => { term.options.theme = buildTermTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Spawn PTY in main process
    if (window.cascade) {
      window.cascade.pty.spawn(cwd ?? '.').then((res) => {
        if (!res.ok) {
          term.writeln(`\x1b[31mTerminal error: ${res.error}\x1b[0m`);
          return;
        }
        window.cascade!.pty.onData((data) => term.write(data));
        window.cascade!.pty.onExit(() => term.writeln('\x1b[90m[Process exited]\x1b[0m'));
        term.onData((data) => window.cascade!.pty.write(data));
      });
    } else {
      term.writeln('\x1b[90m[Terminal requires Electron runtime]\x1b[0m');
    }

    const observer = new ResizeObserver(() => {
      fitRef.current?.fit();
      if (window.cascade) {
        window.cascade.pty.resize(term.cols, term.rows);
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      term.dispose();
      window.cascade?.pty.kill();
    };
  }, [cwd]);

  return <div ref={containerRef} style={{ height: '100%', padding: 4 }} />;
}
