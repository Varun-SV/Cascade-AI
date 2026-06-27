import Editor, { type Monaco, type OnMount } from '@monaco-editor/react';
import { useAppSelector } from '../store/index.js';

interface Props {
  path: string;
  value: string;
  language: string;
  onChange?: (value: string | undefined) => void;
  onMount?: OnMount;
  readOnly?: boolean;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// Define editor themes whose chrome (background, gutter, line highlight) matches
// the app's design tokens, while inheriting Monaco's base syntax colors.
function defineThemes(monaco: Monaco): void {
  monaco.editor.defineTheme('cascade-dark', {
    base: 'vs-dark', inherit: true, rules: [],
    colors: {
      'editor.background': cssVar('--bg-base', '#1b1c1e'),
      'editorGutter.background': cssVar('--bg-base', '#1b1c1e'),
      'editorLineNumber.foreground': cssVar('--text-dim', '#686d75'),
      'editorWidget.background': cssVar('--bg-surface', '#202123'),
      'editor.lineHighlightBackground': cssVar('--bg-raised', '#26282b'),
    },
  });
  monaco.editor.defineTheme('cascade-light', {
    base: 'vs', inherit: true, rules: [],
    colors: {
      'editor.background': cssVar('--bg-surface', '#ffffff'),
      'editorGutter.background': cssVar('--bg-surface', '#ffffff'),
      'editorLineNumber.foreground': cssVar('--text-dim', '#9aa0aa'),
      'editorWidget.background': cssVar('--bg-surface', '#ffffff'),
      'editor.lineHighlightBackground': cssVar('--bg-raised', '#eef0f3'),
    },
  });
}

export function MonacoEditor({ path, value, language, onChange, onMount, readOnly = false }: Props) {
  const dark = useAppSelector((s) => s.app.themeDark);
  return (
    <Editor
      path={path}
      value={value}
      language={language}
      theme={dark ? 'cascade-dark' : 'cascade-light'}
      beforeMount={defineThemes}
      onMount={onMount}
      onChange={onChange}
      options={{
        readOnly,
        fontSize: 13,
        fontFamily: '"JetBrains Mono", "Cascadia Code", monospace',
        fontLigatures: true,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        lineNumbers: 'on',
        renderLineHighlight: 'gutter',
        padding: { top: 8, bottom: 8 },
      }}
    />
  );
}
