// capture on a host where the image library can't load: a crop to one control
// can't be made, and the whole screen is not handed back in its place.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../media/report-images.js', async (load) => ({
  ...(await load<typeof import('../media/report-images.js')>()),
  loadSharp: async () => null,
}));

const { BrowserControlTool } = await import('./browser-control.js');
const { ImageAssets } = await import('../media/report-images.js');

describe('capture without the image library (Codex on e5fb6eb)', () => {
  it('a ref crop is refused rather than saving the whole view', async () => {
    const saved: string[] = [];
    const tool = new BrowserControlTool(async () => ({
      ok: true, detail: 'Observed the page.', url: 'https://shop.example/', title: 'Shop',
      view: { text: 'PAGE VIEW', labels: { e3: 'button "Buy"' } },
      image: { data: Buffer.from('jpeg').toString('base64'), mimeType: 'image/jpeg', width: 800, height: 600 },
      boxes: [{ ref: 'e3', x: 100, y: 100, w: 80, h: 30 }],
    }), undefined, { pageView: true, reportImages: { assets: new ImageAssets(), sink: async (a) => { saved.push(a.filename); return `generated/${a.filename}`; } } });
    const out = await tool.execute({ action: 'capture', ref: 'e3' }, { sessionId: 's' } as never);
    expect(out).toMatch(/^Error: .*Capture without a ref/);
    expect(saved).toEqual([]);
  });
});
