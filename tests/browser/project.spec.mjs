import { test, expect } from '@playwright/test';
test('protected project owner can post Markdown, reload and invite an authenticated member', async ({page}) => {
  await page.goto('/project');
  await page.getByPlaceholder('Project title').fill('Project browser regression');
  await page.getByPlaceholder('Owner nick').fill('owner-browser');
  await page.getByRole('button',{name:'Create project room'}).click();
  await expect(page.locator('#identity')).toHaveText('owner-browser · verified owner');
  await page.getByPlaceholder('Message (Markdown supported)').fill('**Project handoff**\n\n- one\n- two');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await expect(page.locator('article .body strong')).toHaveText('Project handoff');
  await page.reload();
  await expect(page.locator('article .body strong')).toHaveText('Project handoff');
  await page.getByPlaceholder('Participant nick').fill('member-browser');
  await page.getByRole('button',{name:'Issue member credential'}).click();
  await expect(page.locator('#credential')).toContainText('Give member-browser their credential securely: am2_');
  expect(await page.locator('article').count()).toBe(1);
});
