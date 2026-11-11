'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');

for (const outcome of ['delete', 'cancel', 'error']) test('deletion keeps stopped tab after confirmation, visibility and selection clear: ' + outcome, async () => {
  const filename = path.join(__dirname, '../extension.js'), localRequire = createRequire(filename), calls = [], messages = [];
  let visibility, receive, run;
  const source = { threadId: 'stopped', title: 'Stopped', cwd: 'workspace' };
  const vscode = { extensions: { all: [] }, workspace: { getConfiguration: () => ({ get: (_key, value) => value }) },
    window: { showWarningMessage: async () => {
      assert.equal(run('deleteBusy'), true);
      visibility();
      assert.equal(run('showNonRunning'), true, 'revealing after confirmation must keep the chosen tab');
      return outcome === 'cancel' ? undefined : 'Xóa chat';
    } } };
  const view = { visible: true, webview: { postMessage: m => messages.push(m), onDidReceiveMessage: handler => { receive = handler; } },
    onDidChangeVisibility: handler => { visibility = handler; } };
  const context = vm.createContext({ require: name => name === 'vscode' ? vscode
    : name === './tracker' ? { ...localRequire(name), scanConversationSessions: async () => ({ nonRunning: [source], active: [] }),
      scanSessionTree: async () => [source], buildSessionSnapshot: async () => ({ overallStatus: { kind: 'completed' } }) }
    : name === './codex_queue' ? { ...localRequire(name), resolveCodexExecutable: async () => ({ executable: 'fixture' }) }
    : name === './codex_delete' ? { deleteThread: async ({ threadId }) => { calls.push(threadId); if (outcome === 'error') throw new Error('fixture delete failed'); } }
    : localRequire(name), __dirname: path.dirname(filename), process, module: { exports: {} }, console, setInterval, clearInterval, setTimeout, clearTimeout, view, messages });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  run = code => vm.runInContext(code, context);
  run(`contextRef={subscriptions:[],globalState:{get:(_key,value)=>value},workspaceState:{update:async()=>{}}};dashboardHtml=()=>'';renderStatus=()=>{};persistSelection=async()=>{};
    postViewState=()=>messages.push({type:'state',data:{showNonRunning}});refreshAll=async()=>postViewState();
    new TrackerViewProvider().resolveWebviewView(view);
    showNonRunning=true;selected={threadId:'stopped'};`);
  await receive({ command: 'deleteChat', threadId: 'stopped' });
  assert.equal(run('showNonRunning'), true); assert.equal(run('deleteBusy'), false);
  assert.equal(messages.some(m => m.type === 'trackerShown'), false);
  if (outcome === 'cancel') assert.deepEqual(calls, []);
  else assert.deepEqual(calls, ['stopped'], run('JSON.stringify(deleteNotice)'));
  if (outcome === 'delete') { assert.equal(run('selected'), null); assert.equal(run('deleteNotice.kind'), 'success'); }
  if (outcome === 'error') assert.equal(run('deleteNotice.kind'), 'error');
});
