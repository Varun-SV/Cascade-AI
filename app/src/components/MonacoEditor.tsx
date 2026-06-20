import Editor from '@monaco-editor/react';

interface Props {
  path: string;
  value: string;
  language: string;
  onChange?: (value: string | undefined) => void;
  readOnly?: boolean;
}

export function MonacoEditor({ path, value, language, onChange, readOnly = false }: Props) {
  return (
    <Editor
      path={path}
      value={value}
      language={language}
      theme="vs-dark"
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
