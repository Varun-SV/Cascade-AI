import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface Props { cwd?: string }

export function TerminalPanel({ cwd }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: {
        background: '#0d0d0f',
        foreground: '#e8e8ec',
        cursor: '#7c6af7',
        selectionBackground: '#3d358066',
      },
      fontFamily: '"JetBrains Mono", "Cascadia Code", monospace',
      fontSize: 13,
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Spawn PTY in main process
    if (window.cascade) {
      window.cascade.pty.spawn(cwd ?? process.cwd?.() ?? '/').then((res) => {
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
      term.dispose();
      window.cascade?.pty.kill();
    };
  }, [cwd]);

  return <div ref={containerRef} style={{ height: '100%', padding: 4 }} />;
}
