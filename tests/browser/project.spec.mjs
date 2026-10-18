import { test, expect } from '@playwright/test';
test('protected project owner can post Markdown, reload and invite an authenticated member', async ({
  page,
}) => {
  await page.goto('/project');
  await page.getByPlaceholder('Project title').fill('Project browser regression');
  await page.getByPlaceholder('Owner nick').fill('owner-browser');
  await page.getByRole('button', { name: 'Create project room' }).click();
  await expect(page.locator('#identity')).toHaveText('owner-browser · verified owner');
  await page
    .getByPlaceholder('Message (Markdown supported)')
    .fill('**Project handoff**\n\n- one\n- two');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('article .body strong')).toHaveText('Project handoff');
  await page.reload();
  await expect(page.locator('article .body strong')).toHaveText('Project handoff');
  await page.getByPlaceholder('Participant nick').fill('member-browser');
  await page.getByRole('button', { name: 'Issue member credential' }).click();
  await expect(page.locator('#credential')).toContainText(
    'Give member-browser their credential securely: am2_',
  );
  expect(await page.locator('article').count()).toBe(1);
});

test('project inbox acknowledgement and shared board remain explicit across reload', async ({
  page,
  request,
}) => {
  await page.goto('/project');
  await page.getByPlaceholder('Project title').fill('Coordination browser regression');
  await page.getByPlaceholder('Owner nick').fill('coord-owner');
  await page.getByRole('button', { name: 'Create project room' }).click();
  await expect(page.locator('#identity')).toContainText('verified owner');
  const { room, token } = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('agentmeet-project')),
  );
  const invited = await request.post('/v2/rooms/' + room + '/participants', {
    headers: { Authorization: 'Bearer ' + token },
    data: { nick: 'coord-member' },
  });
  expect(invited.status()).toBe(201);
  const member = await invited.json();
  const posted = await request.post('/v2/rooms/' + room + '/messages', {
    headers: { Authorization: 'Bearer ' + member.token, 'Idempotency-Key': 'browser-incoming' },
    data: { text: '**Please verify**' },
  });
  expect(posted.status()).toBe(201);
  await page.getByRole('button', { name: 'Refresh messages' }).click();
  await expect(page.locator('#inbox strong')).toHaveText('Please verify');
  await page.reload();
  await expect(page.locator('#inbox strong')).toHaveText('Please verify');
  await page.getByPlaceholder('Action taken').fill('checked manifest hashes');
  await page.getByRole('button', { name: 'Record acknowledgement' }).click();
  await expect(page.locator('#inbox')).toHaveText('No pending messages.');
  await page.getByPlaceholder('State key', { exact: true }).fill('package');
  await page.getByPlaceholder('State value (JSON)').fill('{"version":1}');
  await page.getByRole('button', { name: 'Save state' }).click();
  await expect(page.locator('#board')).toContainText('package · revision 1');
  await page.getByPlaceholder('Hold scope (for example atlas-main)').fill('atlas-main');
  await page.getByPlaceholder('Reason for hold').fill('suite running');
  await page.getByRole('button', { name: 'Acquire advisory hold for 30 minutes' }).click();
  await expect(page.locator('#board')).toContainText('hold:atlas-main');
  await page.getByRole('button', { name: 'Release hold', exact: true }).click();
  await expect(page.locator('#board')).toContainText('released/deleted');
  await page.reload();
  await expect(page.locator('#inbox')).toHaveText('No pending messages.');
  await expect(page.locator('#board')).toContainText('package · revision 1');
  await page.getByLabel('Keep this room writable without expiry').uncheck();
  await page.getByLabel('Inactivity TTL hours').fill('1');
  await page.getByRole('button', { name: 'Save lifetime' }).click();
  await expect(page.locator('#health')).toContainText('Expires');
  await page.getByPlaceholder('Archive or restore reason').fill('test archive');
  await page.getByRole('button', { name: 'Archive room', exact: true }).click();
  await expect(page.locator('#health')).toContainText('Archived; history preserved');
  await expect(page.locator('#send')).toBeHidden();
  await page.getByPlaceholder('Archive or restore reason').fill('resume test');
  await page.getByRole('button', { name: 'Restore writable room' }).click();
  await expect(page.locator('#send')).toBeVisible();
});

test('project records render audited edits, immutable pins, status, search and owner decisions', async ({
  page,
  request,
}) => {
  await page.goto('/project');
  await page.getByPlaceholder('Owner nick').fill('records-owner');
  await page.getByPlaceholder('Project title').fill('Project records browser regression');
  await page.getByRole('button', { name: 'Create project room' }).click();
  await expect(page.locator('#identity')).toContainText('verified owner');
  const { room, token } = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('agentmeet-project')),
  );
  const post = async (kind, data, text = '', reply_to) => {
    const response = await request.post('/v2/rooms/' + room + '/messages', {
      headers: { Authorization: 'Bearer ' + token, 'Idempotency-Key': crypto.randomUUID() },
      data: { kind, data, text, ...(reply_to ? { reply_to } : {}) },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).message;
  };
  const original = await post('message', null, '**Original Girpilis**');
  const decision = await post('agentmeet.decision.request', {
    action: 'Choose roof material',
    scope: 'Girpilis art',
    options: [
      { id: 'a', label: 'Red tile' },
      { id: 'b', label: 'Slate' },
    ],
    recommended: 'a',
    expires_at: Date.now() + 3600000,
  });
  await page.getByRole('button', { name: 'Refresh messages' }).click();
  const card = page.locator('[id="' + original.id + '"]');
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByPlaceholder('Message (Markdown supported)').fill('**Corrected Girpilis**');
  await page.getByPlaceholder('Reason for revision').fill('corrected count');
  await page.getByRole('button', { name: 'Save edit', exact: true }).click();
  await expect(card.locator('.body strong')).toHaveText('Corrected Girpilis');
  await expect(card.locator('.revision-label')).toContainText('corrected count');
  await page.reload();
  await expect(card.locator('.body strong')).toHaveText('Corrected Girpilis');
  await expect(card.locator('.original-record')).toContainText('Original Girpilis');
  await page.getByPlaceholder('Artifact name').fill('Girpilis package');
  await page.getByPlaceholder('Artifact version').fill('v2');
  await page.getByPlaceholder('SHA-256', { exact: true }).fill('a'.repeat(64));
  await page.getByPlaceholder('Artifact HTTPS URL').fill('https://example.com/material.json');
  await page.getByRole('button', { name: 'Publish immutable pin' }).click();
  await expect(page.locator('#pins')).toContainText('Girpilis package');
  await page.getByPlaceholder('Your status').fill('suite running');
  await page.getByRole('button', { name: 'Update status' }).click();
  await expect(page.locator('#statuses')).toContainText('suite running');
  await page.getByPlaceholder('Search room history').fill('Corrected');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('#search-results')).toContainText('Corrected Girpilis');
  await page.getByRole('button', { name: 'Red tile (recommended)', exact: true }).click();
  await expect(page.locator('#decisions')).toContainText('Owner credential selected a');
  const selected = await request.get('/v2/rooms/' + room + '/decisions', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(
    (await selected.json()).decisions.find((d) => d.request_id === decision.id).selected.data
      .option_id,
  ).toBe('a');
  await card.getByRole('button', { name: 'Retract', exact: true }).click();
  await page.getByPlaceholder('Reason for revision').fill('superseded package');
  await page.getByRole('button', { name: 'Retract message', exact: true }).click();
  await expect(card.locator('.body')).toContainText('Message retracted');
  await page.reload();
  await expect(card.locator('.body')).toContainText('Message retracted');
  await expect(page.locator('#error')).toHaveText('');
});

test('project forms do not put credentials or message contents in URLs without JavaScript', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(baseURL + '/project');
    await page.getByPlaceholder('Room ID', { exact: true }).fill('fake-room');
    await page.getByPlaceholder('Participant token', { exact: true }).fill('secret-placeholder');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page).toHaveURL(baseURL + '/project');
    await expect(page.locator('body')).toContainText('client_required');
  } finally {
    await context.close();
  }
});

test('agent onboarding is reachable from the project browser and its reference links resolve',async({page})=>{
 await page.goto('/project');
 await page.getByRole('link',{name:'Agent setup instructions',exact:true}).click();
 await expect(page).toHaveURL(/\/instructions$/);
 await expect(page.locator('body')).toContainText('native tracked asynchronous tool operation');
 await expect(page.locator('body')).not.toContainText('```');
 await page.goto('/references/listener.md');
 await expect(page.locator('body')).toContainText('Implementation instructions for consuming coding agents');
 await expect(page.locator('body')).toContainText('without a user message or scheduled model turn');
});
