'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../dashboard.html'), 'utf8');

function view(localProxy) {
  const now = 1800000000000;
  class FixtureDate extends Date {
    static now() { return now; }
  }
  const escape = text => String(text ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const context = vm.createContext({
    Date: FixtureDate, fixture: localProxy,
    state: { gateway: {}, localProxy },
    relTime: () => '5m', esc: escape,
    gatewaySettingsValue: () => ({}), renderGatewayPayload: () => ''
  });
  const start = html.indexOf('function proxyRestartTitle(');
  const render = html.indexOf('function renderGateway(');
  const end = html.indexOf('\nfunction ', render + 1);
  assert.ok(start >= 0 && render > start && end > render);
  vm.runInContext(html.slice(start, end), context);
  return {
    title: vm.runInContext('proxyRestartTitle(fixture)', context),
    markup: () => vm.runInContext('renderGateway()', context)
  };
}

test('restart tooltip distinguishes missing success history from a recorded attempt', () => {
  const title = view({ watchdog: { enabled: true, minutes: 5, lastAttemptAt: 1799999940000 } }).title;
  assert.match(title, /Reset thành công gần nhất: Chưa ghi nhận/);
  assert.doesNotMatch(title, /Lần thử gần nhất: Chưa ghi nhận/);
  assert.match(title, /Tự restart: Bật · Ngưỡng 5 phút/);
});

test('restart tooltip exposes successful reset metadata, task age, cooldown and recovery diagnostics', () => {
  const title = view({
    executablePath: 'fixture.exe',
    lastRestart: { at: 1799999400000, source: 'auto', processId: 91, stoppedCount: 1 },
    watchdog: {
      enabled: true, minutes: 5, lastAttemptAt: 1799999940000,
      notice: 'Đang chờ cooldown sau lượt reset trước.',
      assessment: { checkedAt: 1800000000000, taskCount: 1, latestActivityAt: 1799999700000 }
    },
    recovery: { pendingCount: 1 }
  }).title;
  for (const text of ['Nguồn: Tự động', 'PID 91', 'Đã dừng 1 tiến trình',
    'Task đang chạy: 1', '300 giây trước', 'Đánh giá gần nhất:', 'cooldown',
    'Khôi phục: đang theo dõi 1 chat.', 'EXE: fixture.exe', 'Chuột phải để cài đặt']) {
    assert.ok(title.includes(text), text);
  }
});

test('yellow restart button keeps only its icon and escapes tooltip path text', () => {
  const rendered = view({
    executablePath: 'C:\\proxy <test> & "quoted".exe',
    lastRestart: { at: 1799999400000, source: 'manual', processId: 92, stoppedCount: 1 }
  }).markup();
  const button = rendered.match(/<button id="restartLocalProxy"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(button);
  assert.match(button[0], /title="Khởi động lại proxy/);
  assert.match(button[0], /Reset thành công gần nhất:/);
  assert.match(button[0], /Nguồn: Bấm tay/);
  assert.match(button[0], /&lt;test&gt; &amp; &quot;quoted&quot;/);
  assert.match(button[1], /<svg/);
  assert.equal(button[1].replace(/<[^>]*>/g, '').trim(), '');
});
