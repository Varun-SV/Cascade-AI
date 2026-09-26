import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { GenerateDocumentTool, buildDocumentTools } from './generate-document.js';

const OPTS = {} as never;

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-doc-'));
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function tool(): GenerateDocumentTool {
  const t = new GenerateDocumentTool(async (p) => new Uint8Array(await fs.readFile(p)));
  t.setWorkspaceRoot(workspace);
  return t;
}

/** First four bytes of every OOXML archive: the ZIP local-file signature. */
const zipSignature = async (rel: string): Promise<string> => {
  const buf = await fs.readFile(path.join(workspace, rel));
  return buf.subarray(0, 4).toString('latin1');
};

describe('generate_document — writes REAL Office binaries', () => {
  // The whole bug in one assertion: before this tool existed, the only writer
  // on desktop/CLI was file_write, so `report.docx` contained literal Markdown
  // and Word reported it as corrupted. A valid .docx is a ZIP.
  it('renders Markdown into a .docx that is a genuine ZIP archive', async () => {
    const out = await tool().execute(
      { path: 'report.docx', content: '# Title\n\nHello **world**.\n' },
      OPTS,
    );
    expect(await zipSignature('report.docx')).toBe('PK\x03\x04');
    expect(out).toContain('report.docx');
    expect(out).toContain('Word');
  }, 30_000);

  it('renders Markdown slides into a .pptx ZIP', async () => {
    await tool().execute({ path: 'deck.pptx', content: '# One\n\n- a\n\n---\n\n# Two\n\n- b\n' }, OPTS);
    expect(await zipSignature('deck.pptx')).toBe('PK\x03\x04');
  }, 30_000);

  it('renders CSV into an .xlsx whose cells read back', async () => {
    await tool().execute({ path: 'out/data.xlsx', content: 'name,score\nAda,99\n' }, OPTS);
    expect(await zipSignature('out/data.xlsx')).toBe('PK\x03\x04');

    const wb = XLSX.read(await fs.readFile(path.join(workspace, 'out/data.xlsx')));
    expect(wb.Sheets[wb.SheetNames[0]!]!['A2']?.v).toBe('Ada');
  }, 30_000);

  it('creates parent directories rather than failing on a nested path', async () => {
    await tool().execute({ path: 'a/b/c/report.docx', content: '# x\n' }, OPTS);
    await expect(fs.stat(path.join(workspace, 'a/b/c/report.docx'))).resolves.toBeTruthy();
  }, 30_000);

  it('honours an explicit format override over the extension', async () => {
    await tool().execute({ path: 'sheet.bin', content: 'a,b\n1,2\n', format: 'xlsx' }, OPTS);
    expect(await zipSignature('sheet.bin')).toBe('PK\x03\x04');
  }, 30_000);
});

describe('generate_document — refuses what it cannot render', () => {
  it('points a PDF request at pdf_create instead of writing a broken file', async () => {
    const out = await tool().execute({ path: 'report.pdf', content: '# x' }, OPTS);
    expect(out).toContain('pdf_create');
    await expect(fs.stat(path.join(workspace, 'report.pdf'))).rejects.toThrow();
  });

  it('asks for the missing input instead of writing an empty document', async () => {
    expect(await tool().execute({ path: 'a.docx', content: '   ' }, OPTS)).toContain('Provide "content"');
    expect(await tool().execute({ path: '', content: 'x' }, OPTS)).toContain('Provide a "path"');
  });

  it('refuses to escape the workspace', async () => {
    await expect(tool().execute({ path: '../escape.docx', content: '# x' }, OPTS)).rejects.toThrow(/outside workspace root/);
  });
});

describe('generate_document — image embedding and reporting', () => {
  /** A minimal PNG with a real IHDR header, which is all sniffImage reads. */
  const png = (w: number, h: number): Buffer => {
    const buf = Buffer.alloc(33);
    buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    buf.writeUInt32BE(13, 8);
    buf.write('IHDR', 12, 'latin1');
    buf.writeUInt32BE(w, 16);
    buf.writeUInt32BE(h, 20);
    buf[24] = 8; buf[25] = 6;
    return buf;
  };

  it('embeds an image generate_image already wrote into the workspace', async () => {
    await fs.mkdir(path.join(workspace, 'generated'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'generated/cat.png'), png(64, 64));

    const out = await tool().execute(
      { path: 'deck.pptx', content: '# Slide\n\n![a cat](generated/cat.png)\n' },
      OPTS,
    );
    expect(out).toContain('Embedded 1 image');
    const raw = await fs.readFile(path.join(workspace, 'deck.pptx'));
    expect(raw.toString('latin1')).toContain('ppt/media/image');
  }, 30_000);

  // Naming the dropped reference is the point: the failure a user notices is a
  // deck with no picture, and the model can only fix what it is told about.
  it('reports a reference it could not embed instead of failing silently', async () => {
    const out = await tool().execute(
      { path: 'deck.pptx', content: '# Slide\n\n![gone](generated/missing.png)\n' },
      OPTS,
    );
    expect(out).toContain('Could NOT embed 1 image');
    expect(out).toContain('generated/missing.png');
    expect(await zipSignature('deck.pptx')).toBe('PK\x03\x04');
  }, 30_000);

  // An embedded file is copied into the document, which anything can read
  // later: a worker on a cloud model could copy a private image into an
  // ordinary deck, then pull it back out with a command.
  it('does not copy a protected file, or a local-only one into a document that is not local-only', async () => {
    await fs.mkdir(path.join(workspace, 'secret'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'secret/diagram.png'), png(32, 32));
    await fs.writeFile(path.join(workspace, 'key.png'), png(8, 8));
    const t = tool();
    t.setPathGuard((abs) => abs === path.join(workspace, 'key.png'));
    const asked: Array<[string, unknown]> = [];
    const mayRead = (abs: string, to: unknown) => {
      asked.push([abs, to]);
      // As a worker answers: a local-only file only into a local-only file.
      return !abs.includes('/secret/') || (typeof to === 'object' && String((to as { file: string }).file).includes('/secret/'));
    };

    const out = await t.execute(
      { path: 'deck.pptx', content: '# S\n\n![d](secret/diagram.png)\n\n![k](key.png)\n' },
      { mayRead } as never,
    );
    expect(out).toContain('Could NOT embed 2 image');
    expect(out).toContain('secret/diagram.png (local-only');
    expect(out).toContain('key.png (protected');
    expect(asked).toContainEqual([path.join(workspace, 'secret/diagram.png'), { file: path.join(workspace, 'deck.pptx') }]);

    const inside = await t.execute(
      { path: 'secret/deck.pptx', content: '# S\n\n![d](secret/diagram.png)\n' },
      { mayRead } as never,
    );
    expect(inside).toContain('Embedded 1 image');
  }, 30_000);

  // The state folder is protected whole, so `@screenshots/…`, and a
  // local-only subtask's own `@private/…`, were always dropped.
  it('embeds a screenshot, and its own private image for a local-only subtask', async () => {
    const { projectStateDir, statePath, STATE } = await import('../config/project-state.js');
    const before = process.env['CASCADE_GLOBAL_DIR'];
    const global = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-doc-global-'));
    process.env['CASCADE_GLOBAL_DIR'] = global;
    try {
      const shot = statePath(workspace, STATE.screenshots, 'shot.png');
      const mine = statePath(workspace, STATE.private, 'chart.png');
      for (const f of [shot, mine]) {
        await fs.mkdir(path.dirname(f), { recursive: true });
        await fs.writeFile(f, png(16, 16));
      }
      const t = tool();
      const state = projectStateDir(workspace);
      t.setPathGuard((abs) => abs === state || abs.startsWith(state + path.sep));
      const content = '# S\n\n![s](@screenshots/shot.png)\n\n![c](@private/chart.png)\n';
      const cloud = await t.execute({ path: 'deck.pptx', content }, { isOffline: () => false } as never);
      expect(cloud).toContain('Embedded 1 image');
      expect(cloud).toContain("@private/chart.png (a local-only subtask's");
      const local = await t.execute({ path: 'mine.pptx', content }, { isOffline: () => true } as never);
      expect(local).toContain('Embedded 2 image');
      // The state folder by its own path is still not a source.
      const raw = await t.execute({ path: 'raw.pptx', content: `# S\n\n![s](${shot})\n` }, { isOffline: () => true } as never);
      expect(raw).toContain('Could NOT embed 1 image');
    } finally {
      if (before === undefined) delete process.env['CASCADE_GLOBAL_DIR'];
      else process.env['CASCADE_GLOBAL_DIR'] = before;
      await fs.rm(global, { recursive: true, force: true });
    }
  }, 30_000);

  it('explains that a remote URL has to be downloaded first', async () => {
    const out = await tool().execute(
      { path: 'deck.pptx', content: '# Slide\n\n![web](https://example.com/a.png)\n' },
      OPTS,
    );
    expect(out).toContain('remote URL');
  }, 30_000);
});

describe('generate_document — charts', () => {
  const CHART = '# Revenue\n\n```chart:bar\ntitle: Quarterly revenue\nQuarter,Revenue\nQ1,120\nQ2,150\n```\n';

  it('turns a chart block into a real PowerPoint chart part', async () => {
    const out = await tool().execute({ path: 'deck.pptx', content: CHART }, OPTS);
    const raw = await fs.readFile(path.join(workspace, 'deck.pptx'));
    expect(raw.toString('latin1')).toContain('ppt/charts/chart1.xml');
    expect(out).toContain('real, editable PowerPoint charts');
  }, 30_000);

  it('says plainly that Word gets a table, because Word has no chart object', async () => {
    const out = await tool().execute({ path: 'report.docx', content: CHART }, OPTS);
    expect(out).toContain('cannot hold a native chart object');
    expect(await zipSignature('report.docx')).toBe('PK\x03\x04');
  }, 30_000);

  it('puts chart data on its own Excel worksheet as numbers', async () => {
    await tool().execute({ path: 'book.xlsx', content: `region,total\nEMEA,5\n${CHART.slice(CHART.indexOf('```'))}` }, OPTS);
    const wb = XLSX.read(await fs.readFile(path.join(workspace, 'book.xlsx')));
    expect(wb.SheetNames).toContain('Quarterly revenue');
    expect(wb.Sheets['Quarterly revenue']!['B2']?.v).toBe(120);
  }, 30_000);
});

describe('buildDocumentTools', () => {
  // Mirrors buildMediaTools' transcribe_audio gate: a host with no filesystem
  // (the cloud) must not be handed a tool that can only ever fail — it has its
  // own browser-side exporter.
  it('registers the tool only where there is a workspace to write into', () => {
    expect(buildDocumentTools(async () => new Uint8Array()).map((t) => t.name)).toEqual(['generate_document']);
    expect(buildDocumentTools()).toEqual([]);
  });

  it('tells the model, in the tool description, not to reach for file_write', () => {
    const [t] = buildDocumentTools(async () => new Uint8Array());
    expect(t!.description).toContain('file_write');
    expect(t!.description).toContain('corrupted');
  });
});
