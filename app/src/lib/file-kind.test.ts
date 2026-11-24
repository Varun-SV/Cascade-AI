import { describe, it, expect } from 'vitest';
import { fileKind, looksBinary, extensionOf } from './file-kind.js';

const bytes = (...n: number[]) => new Uint8Array(n);
const ascii = (s: string) => new TextEncoder().encode(s);

describe('fileKind by extension', () => {
  it.each([
    ['a.png', 'image', 'image/png'], ['A.JPG', 'image', 'image/jpeg'], ['x.svg', 'image', 'image/svg+xml'],
    ['x.avif', 'image', 'image/avif'], ['doc.pdf', 'pdf', 'application/pdf'],
    ['s.mp3', 'audio', 'audio/mpeg'], ['s.flac', 'audio', 'audio/flac'],
    ['v.mp4', 'video', 'video/mp4'], ['v.webm', 'video', 'video/webm'],
  ])('%s -> %s', (name, kind, mime) => {
    expect(fileKind(name)).toEqual({ kind, mime });
  });
  it('known binaries are binary without sniffing', () => {
    expect(fileKind('report.docx').kind).toBe('binary');
    expect(fileKind('a.zip', ascii('plain text')).kind).toBe('binary');
  });
  it('code is text', () => {
    expect(fileKind('main.ts', ascii('const a = 1;')).kind).toBe('text');
    expect(fileKind('README').kind).toBe('text');
    expect(fileKind('.gitignore').kind).toBe('text');
  });
  it('extension beats content', () => {
    expect(fileKind('pic.png', ascii('not really a png')).kind).toBe('image');
  });
  it('handles paths', () => {
    expect(extensionOf('/a.b/c/file.PNG')).toBe('png');
    expect(extensionOf('C:\\x.y\\noext')).toBe('');
  });
});

describe('content sniffing for unknown extensions', () => {
  it('NUL byte means binary', () => {
    expect(fileKind('data.xyz', bytes(0x41, 0x00, 0x42)).kind).toBe('binary');
  });
  it('high control-byte ratio means binary', () => {
    expect(fileKind('data.xyz', bytes(1, 2, 3, 4, 5, 6, 7, 8, 0x41, 0x42)).kind).toBe('binary');
  });
  it('plain text, UTF-8 and whitespace controls stay text', () => {
    expect(fileKind('notes.xyz', ascii('héllo\tworld\r\nline two\n')).kind).toBe('text');
  });
  it('empty file is text', () => {
    expect(fileKind('empty.xyz', new Uint8Array(0)).kind).toBe('text');
    expect(looksBinary(new Uint8Array(0))).toBe(false);
  });
  it('only the first 8 KB is considered', () => {
    const b = new Uint8Array(9000).fill(0x61);
    b[8500] = 0;
    expect(looksBinary(b)).toBe(false);
  });
  it('an extension that names an Object property is not media', () => {
    for (const name of ['notes.constructor', 'notes.__proto__', 'notes.toString', 'notes.hasOwnProperty']) {
      expect(fileKind(name, ascii('plain text')), name).toEqual({ kind: 'text', mime: null });
    }
  });
});
