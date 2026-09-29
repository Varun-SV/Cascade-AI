import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });

test('on a phone the text box has its own line above the controls, and no sideways scroll', async ({ page }) => {
  await page.goto('/');
  // Sign-in lives in a dialog opened from the landing page.
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByPlaceholder('Your name').fill('E2E Phone');
  await page.getByText('Dev login').click();

  const box = page.locator('textarea').first();
  await expect(box).toBeVisible({ timeout: 15_000 });
  const text = (await box.boundingBox())!;
  const send = (await page.getByLabel('Send').boundingBox())!;
  const plus = (await page.getByLabel('Attach and skills').boundingBox())!;

  // The text box sits above the row of controls and spans the composer.
  expect(text.y + text.height).toBeLessThanOrEqual(send.y);
  expect(text.y + text.height).toBeLessThanOrEqual(plus.y);
  expect(text.width).toBeGreaterThan(send.x + send.width - plus.x - 24);
  // The placeholder fits on one line.
  const fits = await box.evaluate((el) => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    const cs = getComputedStyle(el);
    ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
    return ctx.measureText((el as HTMLTextAreaElement).placeholder).width
      <= el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  });
  expect(fits).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
