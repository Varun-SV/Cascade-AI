// Decide how the Code view should open a file: in the editor, as media, or as a
// "can't show this" placeholder. Pure so it can be unit-tested without Electron.

export type FileKind = 'text' | 'image' | 'pdf' | 'audio' | 'video' | 'binary';
export interface FileKindInfo { kind: FileKind; mime: string | null }

const MEDIA: Record<string, { kind: FileKind; mime: string }> = {
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  svg: { kind: 'image', mime: 'image/svg+xml' },
  bmp: { kind: 'image', mime: 'image/bmp' },
  ico: { kind: 'image', mime: 'image/x-icon' },
  avif: { kind: 'image', mime: 'image/avif' },
  pdf: { kind: 'pdf', mime: 'application/pdf' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  mkv: { kind: 'video', mime: 'video/x-matroska' },
};

// Known non-media binaries: never worth sniffing.
const BINARY_EXT = new Set([
  'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'jar', 'wasm', 'dmg', 'iso', 'pyc', 'node', 'db', 'sqlite',
  'ttf', 'otf', 'woff', 'woff2', 'psd', 'avi', 'wmv', 'wma',
]);

export function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase();
}

/** True when the sample looks like binary: a NUL byte, or many control bytes. */
export function looksBinary(bytes: Uint8Array, sampleSize = 8192): boolean {
  const n = Math.min(bytes.length, sampleSize);
  if (n === 0) return false;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    if (b === 0) return true;
    // Allow tab, LF, FF, CR, ESC; other control bytes and DEL are suspicious.
    if ((b < 32 && b !== 9 && b !== 10 && b !== 12 && b !== 13 && b !== 27) || b === 127) control++;
  }
  return control / n > 0.1;
}

export function fileKind(name: string, firstBytes?: Uint8Array): FileKindInfo {
  const ext = extensionOf(name);
  // Own entries only: "x.constructor" or "x.__proto__" is not a media type.
  const media = Object.prototype.hasOwnProperty.call(MEDIA, ext) ? MEDIA[ext] : undefined;
  if (media) return { kind: media.kind, mime: media.mime };
  if (BINARY_EXT.has(ext)) return { kind: 'binary', mime: null };
  if (firstBytes && looksBinary(firstBytes)) return { kind: 'binary', mime: null };
  return { kind: 'text', mime: null };
}
