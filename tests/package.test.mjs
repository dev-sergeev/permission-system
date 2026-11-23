import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createReviewerProvider } from './reviewer-provider.mjs';

// Exercise Pi's actual resource loader, command dispatcher, tool_call hooks and TUI dialog.
// Only provider responses and terminal keypresses are supplied by the test; no tools execute.
test('data-ops policy and session-only manual review in a clean project', { timeout: 30000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'permission-system-test-')));
  const sessions = [];
  t.after(async () => {
    for (const s of sessions) {
      await s.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      s.dispose();
    }
    await rm(root, { recursive: true, force: true });
  });
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = '1';
  process.env.PI_TELEMETRY = 'off';
  t.mock.method(globalThis, 'fetch', () => { throw new Error('External network disabled in contract test'); });
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, initTheme } = await import('@earendil-works/pi-coding-agent');
  const fixture = createReviewerProvider();
  const secondFixture = createReviewerProvider({ provider: 'offline-two' });
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
  const entry = process.env.PERMISSION_SYSTEM_TEST_ENTRY ?? fileURLToPath(new URL('../index.mjs', import.meta.url));
  const start = async () => {
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [entry], extensionFactories: [pi => {
        pi.registerProvider(fixture.provider);
        pi.registerProvider(secondFixture.provider);
      }],
    });
    await resourceLoader.reload();
    const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(cwd) });
    sessions.push(session);
    assert.deepEqual(extensionsResult.errors, []);
    return session;
  };
  const session = await start();
  initTheme('dark');
  const theme = session.extensionRunner.createCommandContext().ui.theme;
  const dialogs = [];
  const notifications = [];
  let answer = 'n';
  const ui = {
    theme, setStatus() {}, notify(message) { notifications.push(message); }, getToolsExpanded: () => false,
    custom: factory => new Promise((resolve, reject) => {
      const dialog = factory({ requestRender() {} }, theme, { matches: () => false }, resolve);
      dialogs.push(dialog.render(180).join('\n'));
      dialog.handleInput(answer);
      dialog.handleInput(answer); // Also handles double-press confirmation when enabled.
      reject(new Error(`Dialog did not accept ${answer}`));
    }),
  };
  await session.bindExtensions({ mode: 'tui', uiContext: ui });
  const selectModel = async (target, provider, id) => {
    const model = target.extensionRunner.getModelRegistry().find(provider, id);
    assert.ok(model, `registered model ${provider}/${id}`);
    await target.setModel(model, { persist: false });
  };
  await selectModel(session, 'offline-one', 'model-one');
  let id = 0;
  const call = (toolName, input) => session.extensionRunner.emitToolCall({ type: 'tool_call', toolName, input, toolCallId: `call-${++id}` });
  const bash = command => call('bash', { command });
  const write = path => call('write', { path, content: 'test' });

  for (const command of ['hadoop fs -rm /data', 'hdfs dfs -ls / | hadoop fs -rm /data']) {
    const result = await bash(command);
    assert.equal(result?.block, true, command);
    assert.match(result.reason, /hadoop fs/i);
  }
  assert.equal((await write('.pi/settings.json'))?.block, true);
  assert.equal(fixture.state.callCount, 0, 'explicit denies precede model review');
  assert.deepEqual(dialogs, []);
  answer = 'y'; // A bare Hadoop "/" can also refer to a local filesystem.
  const listing = await bash('hdfs dfs -ls /');
  assert.equal(listing?.block, undefined, `${listing?.reason}; model calls=${fixture.state.callCount}; dialogs=${dialogs.join('; ')}`);
  assert.equal(fixture.state.callCount, 1);
  assert.deepEqual(fixture.state.models.at(-1), { provider: 'offline-one', id: 'model-one' });
  // Dialog text may contain SGR sequences from the user's terminal theme.
  assert.match(dialogs.pop().replaceAll(/\x1b\[[\d;]*m/g, ''), /external path\s*: \//);
  answer = 'n';
  assert.match(fixture.state.systemPrompts[0], /NEEDS_EVIDENCE/);
  assert.match(fixture.state.systemPrompts[0], /удалённые данные/);
  fixture.setVerdict('deny');
  assert.equal((await write('report.txt'))?.block, true);
  assert.equal(dialogs.length, 0, 'model denial is not a request for manual approval');
  fixture.setVerdict('allow');
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'external');
  await symlink(outside, join(cwd, 'alias'));
  assert.equal((await call('read', { path: 'alias' }))?.block, true);
  assert.match(dialogs.at(-1), /outside\.txt/);
  assert.equal((await write('alias'))?.block, true, 'model approval cannot replace external write consent');

  await session.prompt('/permission-auto-review off');
  const before = fixture.state.callCount;
  const count = dialogs.length;
  assert.equal((await bash('python report.py'))?.block, true);
  answer = 'y';
  assert.equal((await write('report.txt'))?.block, undefined);
  assert.equal(dialogs.length, count + 2, 'operator denied one ask and approved another');
  assert.equal((await bash('hadoop fs -rm /data'))?.block, true);
  assert.equal(dialogs.length, count + 2);
  assert.equal(fixture.state.callCount, before, 'manual mode never calls the reviewer');
  assert.deepEqual(await readdir(cwd), ['alias'], 'activation and off leave no project config');
  await session.reload();
  assert.equal((await write('report.txt'))?.block, undefined);
  assert.equal(fixture.state.callCount, before + 1, 'reload restores automatic review');

  await selectModel(session, 'offline-two', 'model-two');
  const secondBefore = secondFixture.state.callCount;
  assert.equal((await write('switched.txt'))?.block, undefined);
  assert.equal(secondFixture.state.callCount, secondBefore + 1);
  assert.deepEqual(secondFixture.state.models.at(-1), { provider: 'offline-two', id: 'model-two' },
    'the next review inherits the newly selected session model and provider');
  await session.prompt('/permission-auto-review show');
  assert.match(notifications.at(-1), /provider=offline-two \(session\)/);
  assert.match(notifications.at(-1), /model=model-two \(session\)/);

  const reviewerConfig = join(agentDir, 'extensions/pi-permission-auto-review');
  await assert.rejects(access(join(reviewerConfig, 'config.json')), { code: 'ENOENT' },
    'selecting a session model does not write reviewer settings');
  const projectReviewerConfig = join(cwd, '.pi/extensions/pi-permission-auto-review');
  await mkdir(reviewerConfig, { recursive: true });
  await mkdir(projectReviewerConfig, { recursive: true });
  await writeFile(join(reviewerConfig, 'config.json'), JSON.stringify({ provider: 'offline-one' }));
  await session.reload();
  const beforeProviderOverride = fixture.state.callCount;
  assert.equal((await write('provider-override.txt'))?.block, undefined);
  assert.equal(fixture.state.callCount, beforeProviderOverride + 1);
  assert.deepEqual(fixture.state.models.at(-1), { provider: 'offline-one', id: 'model-two' },
    'a provider override inherits the current session model ID');

  await writeFile(join(projectReviewerConfig, 'config.json'), JSON.stringify({ model: 'model-one' }));
  await session.reload();
  const beforeProjectOverride = fixture.state.callCount;
  assert.equal((await write('project-override.txt'))?.block, undefined);
  assert.equal(fixture.state.callCount, beforeProjectOverride + 1);
  assert.deepEqual(fixture.state.models.at(-1), { provider: 'offline-one', id: 'model-one' },
    'trusted project settings layer over global settings');

  await rm(join(reviewerConfig, 'config.json'));
  await session.reload();
  const beforeModelOverride = secondFixture.state.callCount;
  assert.equal((await write('model-override.txt'))?.block, undefined);
  assert.equal(secondFixture.state.callCount, beforeModelOverride + 1);
  assert.deepEqual(secondFixture.state.models.at(-1), { provider: 'offline-two', id: 'model-one' },
    'a model override inherits the current session provider');

  await session.prompt('/permission-auto-review off');
  const manualCalls = fixture.state.callCount + secondFixture.state.callCount;
  answer = 'n';
  assert.equal((await write('manual-after-switch.txt'))?.block, true);
  assert.equal(fixture.state.callCount + secondFixture.state.callCount, manualCalls,
    'manual mode remains in force after model selection and config overrides');
  await rm(join(projectReviewerConfig, 'config.json'));
  answer = 'y';

  const headless = await start();
  await headless.bindExtensions({ mode: 'print' });
  const result = await headless.extensionRunner.emitToolCall({ type: 'tool_call', toolName: 'read', input: { path: 'alias' }, toolCallId: 'headless-external' });
  assert.equal(result?.block, true, 'without a human an external-path ask fails closed');

  await writeFile(join(reviewerConfig, 'config.json'), JSON.stringify({ provider: 'not-installed' }));
  const unavailable = await start();
  await unavailable.bindExtensions({ mode: 'print' });
  await selectModel(unavailable, 'offline-two', 'model-two');
  const beforeUnavailable = fixture.state.callCount + secondFixture.state.callCount;
  const missingProvider = await unavailable.extensionRunner.emitToolCall({ type: 'tool_call', toolName: 'write', input: { path: 'report.txt', content: 'x' }, toolCallId: 'headless-ask' });
  assert.equal(missingProvider?.block, true, 'without a reviewer or operator a project write fails closed');
  assert.equal(fixture.state.callCount + secondFixture.state.callCount, beforeUnavailable,
    'an unavailable override does not silently use the session model');
});
