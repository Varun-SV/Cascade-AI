import { describe, expect, it } from 'vitest';
import { desktopHandoffNotice } from './desktopHandoff.js';

describe('handing a message to the desktop app', () => {
  it('says nothing of files when there are none', () => {
    expect(desktopHandoffNotice([])).not.toMatch(/Files/);
  });

  it('names the files that cannot go with it, so they are not dropped silently', () => {
    expect(desktopHandoffNotice(['report.pdf', 'an image'])).toMatch(/Files don't go with it: attach report\.pdf, an image again in the app\./);
  });
});
