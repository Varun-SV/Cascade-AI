import { describe, it, expect } from 'vitest';
import { fileExt, fileKind, codeLanguage, parseDelimited } from './fileKind.js';

describe('fileExt', () => {
  it('extracts the lowercased extension', () => {
    expect(fileExt('report.MD')).toBe('md');
    expect(fileExt('a/b/data.csv')).toBe('csv');
    expect(fileExt('Makefile')).toBe('');
    expect(fileExt('.gitignore')).toBe(''); // leading-dot only → no ext
    expect(fileExt('archive.tar.gz')).toBe('gz');
  });
});

describe('fileKind', () => {
  it('maps common extensions to a preview kind', () => {
    expect(fileKind('notes.md')).toBe('markdown');
    expect(fileKind('data.csv')).toBe('csv');
    expect(fileKind('sheet.tsv')).toBe('csv');
    expect(fileKind('page.html')).toBe('html');
    expect(fileKind('logo.svg')).toBe('svg');
    expect(fileKind('pic.PNG')).toBe('image');
    expect(fileKind('main.ts')).toBe('code');
    expect(fileKind('config.json')).toBe('code');
    expect(fileKind('README')).toBe('text');
  });
  it('falls back to MIME when the extension is unknown', () => {
    expect(fileKind('blob', 'image/png')).toBe('image');
    expect(fileKind('blob', 'image/svg+xml')).toBe('svg');
    expect(fileKind('blob', 'text/markdown')).toBe('markdown');
    expect(fileKind('blob', 'text/csv')).toBe('csv');
    expect(fileKind('blob', 'application/json')).toBe('code');
    expect(fileKind('blob', 'application/octet-stream')).toBe('text');
  });
});

describe('codeLanguage', () => {
  it('resolves highlight.js language hints', () => {
    expect(codeLanguage('a.ts')).toBe('typescript');
    expect(codeLanguage('a.py')).toBe('python');
    expect(codeLanguage('a.yml')).toBe('yaml');
    expect(codeLanguage('a.rs')).toBe('rust');
  });
});

describe('parseDelimited', () => {
  it('parses simple CSV', () => {
    expect(parseDelimited('a,b,c\n1,2,3', 'x.csv')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });
  it('handles quoted fields with commas, quotes, and newlines', () => {
    const csv = 'name,note\n"Doe, John","said ""hi""\nagain"';
    expect(parseDelimited(csv, 'x.csv')).toEqual([
      ['name', 'note'],
      ['Doe, John', 'said "hi"\nagain'],
    ]);
  });
  it('uses tab for .tsv', () => {
    expect(parseDelimited('a\tb\n1\t2', 'x.tsv')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('drops a trailing empty line', () => {
    expect(parseDelimited('a,b\n1,2\n', 'x.csv')).toEqual([['a', 'b'], ['1', '2']]);
  });
});
