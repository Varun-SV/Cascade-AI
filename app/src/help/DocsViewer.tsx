import { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import Fuse from 'fuse.js';
import { Search } from 'lucide-react';

interface Section { heading: string; body: string; raw: string }

function parseMarkdown(md: string): Section[] {
  const lines = md.split('\n');
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current) sections.push(current);
      current = { heading: line.slice(3).trim(), body: '', raw: line + '\n' };
    } else if (current) {
      current.body += line + '\n';
      current.raw += line + '\n';
    }
  }
  if (current) sections.push(current);
  return sections;
}

interface Props { content: string }

export function DocsViewer({ content }: Props) {
  const [query, setQuery] = useState('');
  const sections = useMemo(() => parseMarkdown(content), [content]);

  const fuse = useMemo(() => new Fuse(sections, {
    keys: ['heading', 'body'],
    threshold: 0.35,
    includeMatches: true,
  }), [sections]);

  const visible = query.trim()
    ? fuse.search(query).map((r) => r.item)
    : sections;

  const displayContent = visible.length > 0
    ? visible.map((s) => s.raw).join('\n')
    : content;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      <div style={{ position: 'relative' }}>
        <Search size={12} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search docs…"
          style={{
            width: '100%', padding: '6px 10px 6px 30px', boxSizing: 'border-box',
            background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 6,
            color: 'var(--text)', fontSize: 12, outline: 'none',
          }}
        />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', fontSize: 12, lineHeight: 1.7, color: 'var(--text)' }}>
        {query && visible.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>No results for "{query}"</p>
        ) : (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ className, children, ...rest }) {
                const match = /language-(\w+)/.exec(className ?? '');
                return match ? (
                  <SyntaxHighlighter
                    style={vscDarkPlus as Record<string, React.CSSProperties>}
                    language={match[1]}
                    PreTag="div"
                    customStyle={{ borderRadius: 6, fontSize: 11 }}
                  >
                    {String(children).replace(/\n$/, '')}
                  </SyntaxHighlighter>
                ) : (
                  <code {...rest} style={{ background: 'var(--bg-raised)', padding: '1px 5px', borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    {children}
                  </code>
                );
              },
              h1: ({ children }) => <h1 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px', color: 'var(--text)' }}>{children}</h1>,
              h2: ({ children }) => <h2 style={{ fontSize: 13, fontWeight: 600, margin: '16px 0 8px', color: 'var(--text)', borderBottom: '1px solid var(--border)', paddingBottom: 4 }}>{children}</h2>,
              h3: ({ children }) => <h3 style={{ fontSize: 12, fontWeight: 600, margin: '12px 0 4px', color: 'var(--text)' }}>{children}</h3>,
              p: ({ children }) => <p style={{ margin: '0 0 8px', color: 'var(--text-muted)' }}>{children}</p>,
              table: ({ children }) => <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11, marginBottom: 12 }}>{children}</table>,
              th: ({ children }) => <th style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)', textAlign: 'left', color: 'var(--text)', fontWeight: 600 }}>{children}</th>,
              td: ({ children }) => <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>{children}</td>,
              ul: ({ children }) => <ul style={{ margin: '0 0 8px', paddingLeft: 20, color: 'var(--text-muted)' }}>{children}</ul>,
              ol: ({ children }) => <ol style={{ margin: '0 0 8px', paddingLeft: 20, color: 'var(--text-muted)' }}>{children}</ol>,
              li: ({ children }) => <li style={{ marginBottom: 2 }}>{children}</li>,
              strong: ({ children }) => <strong style={{ color: 'var(--text)', fontWeight: 600 }}>{children}</strong>,
            }}
          >
            {displayContent}
          </ReactMarkdown>
        )}
      </div>
    </div>
  );
}
