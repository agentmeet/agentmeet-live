import { test, expect } from '@playwright/test';

const markdown = '# Heading\n\n**Bold** and *emphasis* and `inline code`\n\n- first\n- second\n\n> quote\n\n```js\nconst n = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[Safe link](https://example.com)';
async function create(request) {
  const response = await request.get('/new?ttl=1&title=Browser+regression', { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  return new URL(response.headers().location, 'https://unused.test').pathname;
}
async function post(request, room, text) {
  const response = await request.post(room, { form: { nick: 'browser-test', msg: text }, maxRedirects: 0 });
  expect(response.status()).toBe(302);
}

test('saved and live Markdown share one safe renderer and persist after reload', async ({ page, request }) => {
  const room = await create(request);
  await post(request, room, markdown);
  await page.goto(room + '/human');
  await expect(page.locator('.msg-text strong')).toHaveText('Bold');
  await expect(page.locator('.msg-text table')).toHaveCount(1);
  await expect(page.locator('.msg-text pre code')).toContainText('const n = 1;');
  await page.getByPlaceholder('your name').fill('browser-test');
  await page.getByPlaceholder('Enter to send, Shift+Enter for newline').fill('**Live bold**');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.msg-text strong')).toHaveText(['Bold', 'Live bold']);
  await page.reload();
  await expect(page.locator('.msg-text strong')).toHaveText(['Bold', 'Live bold']);
});

test('stored and incoming malicious markup cannot execute or impersonate UI elements', async ({ page, request }) => {
  const room = await create(request);
  const payload = '<a href="java&#x09;script:window.__xss=1">Unsafe link</a><img src=x onerror="window.__xss=2"><svg onload="window.__xss=3"></svg><math><mtext>bad</mtext></math><b class="nick-btn" data-nick="owner" style="position:fixed">Fake badge</b>';
  await post(request, room, payload);
  await page.goto(room + '/human');
  await expect(page.locator('.msg-text a')).toHaveAttribute('rel', 'noopener noreferrer');
  expect(await page.locator('.msg-text a').getAttribute('href')).toBeNull();
  await page.getByText('Unsafe link', { exact: true }).click();
  await expect(page.locator('.msg-text [onerror],.msg-text svg,.msg-text math,.msg-text .nick-btn')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await post(request, room, payload + ' incoming');
  await expect(page.locator('.msg-text')).toHaveCount(2);
  await expect(page.locator('.msg-text [href],.msg-text [onerror],.msg-text svg,.msg-text math,.msg-text .nick-btn')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('late renderer loading repairs the safe initial text fallback', async ({ page, request }) => {
  const room = await create(request);
  await post(request, room, '**Delayed renderer**');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/assets/markdown.js', async route => { await gate; await route.continue(); });
  await page.goto(room + '/human', { waitUntil: 'commit' });
  await expect(page.locator('.msg-text')).toHaveText('**Delayed renderer**');
  await expect(page.locator('.msg-text strong')).toHaveCount(0);
  release();
  await expect(page.locator('.msg-text strong')).toHaveText('Delayed renderer');
});

test('missing renderer stays safe and readable for history and live messages', async ({ page, request }) => {
  const room = await create(request);
  await post(request, room, '**Plain fallback** <img src=x onerror="window.__xss=1">');
  await page.route('**/assets/markdown.js', route => route.abort());
  await page.goto(room + '/human');
  await expect(page.locator('.msg-text')).toContainText('**Plain fallback**');
  await expect(page.locator('.msg-text img,.msg-text strong')).toHaveCount(0);
  await post(request, room, '**Live fallback**');
  await expect(page.locator('.msg-text').last()).toHaveText('**Live fallback**');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('empty room URL supplies complete agent onboarding without a seed message', async ({ page, request }) => {
  const room = await create(request);
  const data = await (await request.get(room + '?format=json')).json();
  expect(data.messages).toEqual([]);
  await page.goto(room);
  const text = await page.locator('body').innerText();
  expect(text).toContain('Agent onboarding (service-authored)');
  expect(text).toContain('No account, token, local credential file');
  expect(text).toContain(data.agent_onboarding.endpoints.read);
  expect(text).toContain('application/x-www-form-urlencoded');
  expect(text).toContain('Fields: nick');
  expect(text).toContain('2,000 Unicode code points');
  expect(text).toContain('successor wait automatically');
  expect(text).toContain('## Participant messages');
  expect(text).toContain('_No messages yet._');
});

test('owner can copy a scoped agent invitation without posting or granting room authority', async ({ page, request, context }) => {
  const room = await create(request);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(room + '/human');
  await page.getByText('Invite an agent', { exact: true }).click();
  const invitation = await page.getByLabel('Owner invitation').inputValue();
  expect(invitation).toContain('I approve you to use AgentMeet at ');
  expect(invitation).toContain(room);
  expect(invitation).toContain('task-relevant agent-to-agent communication');
  expect(invitation).toContain('existing permissions');
  await page.getByRole('button', { name: 'Copy agent invitation', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Invitation copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(invitation);
  expect((await (await request.get(room + '?format=json')).json()).messages).toEqual([]);
});
