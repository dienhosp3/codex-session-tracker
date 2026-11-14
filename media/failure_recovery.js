/* Only errors and transport metadata enter this panel. */
window.TrackerFailureUI = (() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function render(state) {
    const recovery = state.failureRecovery || {}, e = recovery.entries?.[state.selectedThreadId];
    if (!e || ['resolved', 'dismissed'].includes(e.phase)) return '';
    const locked = e.busy || ['working', 'unknown', 'awaiting_result'].includes(e.phase);
    const button = (action, label, disabled = false) => '<button type="button" data-failure-action="' + action + '" ' + (disabled ? 'disabled' : '') + '>' + label + '</button>';
    const retry = !['context', 'quota', 'auth'].includes(e.category);
    let actions = button('diagnose', 'Kiểm tra kết nối', e.busy);
    if (retry) actions += button('retry', 'Tiếp tục một lần', locked);
    if (e.category === 'context') actions += button('compact', 'Compact và tiếp tục', locked) + button('transfer', 'Chuyển chat', locked);
    if (e.category === 'proxy') actions += button('restart', 'Restart proxy', locked);
    if (['quota','rate_limit','auth','capacity'].includes(e.category)) actions += button('accounts', 'Chọn account', locked);
    if (e.category === 'capacity') actions += button('model', 'Đổi model được phép', locked);
    actions += button('dismiss', 'Ẩn lỗi này', locked);
    const network = e.connection ? '<div class="sub">Kết nối lúc ' + esc(new Date(e.connection.checkedAt).toLocaleTimeString('vi-VN')) + ': ' +
      (e.connection.online ? 'các đích kiểm tra đang phản hồi. Không bảo đảm stream sinh nội dung sẽ thành công.' : 'chưa sẵn sàng; xem hướng dẫn bên trên.') + '</div>' : '';
    return '<section class="failure-panel" role="status" data-failure-thread="' + esc(e.threadId) + '" data-failure-turn="' + esc(e.turnId) + '">' +
      '<strong>' + esc(e.label) + (e.confidence === 'correlated' ? ' — nghi vấn từ relay' : '') + '</strong><p>' + esc(e.guidance) + '</p>' +
      (e.notice ? '<p>' + esc(e.notice) + '</p>' : '') + network + '<details><summary>Lỗi kỹ thuật</summary><pre>' + esc(e.message) + '</pre></details>' +
      '<div class="failure-actions">' + actions + '</div><label><input type="checkbox" data-failure-auto ' + (recovery.autoResume ? 'checked' : '') + '> Tự tiếp tục khi kết nối ổn định (tối đa 3 lần)</label>' +
      '<div class="sub">Không tự compact, đổi chat, restart proxy hoặc gửi lại khi chưa rõ lượt trước đã được nhận.</div></section>';
  }
  function bind(root, post) {
    const panel = root.querySelector('.failure-panel'); if (!panel) return;
    const send = (action, extra = {}) => post({ command: 'failureAction', threadId: panel.dataset.failureThread, turnId: panel.dataset.failureTurn, action, ...extra });
    for (const button of panel.querySelectorAll('[data-failure-action]')) button.onclick = () => { button.disabled = true; send(button.dataset.failureAction); };
    panel.querySelector('[data-failure-auto]').onchange = event => send('auto', { enabled: event.target.checked });
  }
  return { render, bind };
})();
