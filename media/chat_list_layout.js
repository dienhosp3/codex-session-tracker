let chatListLayoutFrame = 0, chatListAutoFit = true;
function fitVisibleChatList() {
  chatListAutoFit = true;
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) sidebar.scrollTop = 0;
  scheduleChatListLayout();
}
function chatListMeasurements() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return { first: 100, all: 190 };
  const rect = sidebar.getBoundingClientRect(), style = getComputedStyle(sidebar);
  const bottom = (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.borderBottomWidth) || 0) + 2;
  const cards = [...chatList.querySelectorAll('.chat')];
  const first = cards[0] || chatList, last = cards.at(-1) || chatList;
  return {
    first: Math.ceil(first.getBoundingClientRect().bottom - rect.top + sidebar.scrollTop + bottom),
    all: Math.ceil(last.getBoundingClientRect().bottom - rect.top + sidebar.scrollTop + bottom)
  };
}
function chatListHeightLimits() {
  const available = Math.max(0, window.innerHeight - 9), first = chatListMeasurements().first;
  const detail = document.getElementById('main'), head = detail?.querySelector('.head');
  let reserve = Math.min(160, available * 0.45);
  if (head) {
    const rect = detail.getBoundingClientRect();
    const bottomOf = element => element.getBoundingClientRect().bottom - rect.top + detail.scrollTop + 12;
    const headerEnd = bottomOf(detail.querySelector('.view-switch') || head);
    const account = detail.querySelector('.auth-session-card');
    // Keep the title, model and summary controls visible before fitting rows.
    // The account/context card also fits when the viewport can accommodate it.
    reserve = Math.min(Math.max(0, available - 40), Math.max(headerEnd,
      Math.min(account ? bottomOf(account) : headerEnd, Math.max(0, available - 100))));
  }
  const max = Math.max(0, Math.floor(available - reserve));
  return { min: Math.min(max, Math.max(100, first)), max };
}
function scheduleChatListLayout(force = false) {
  if (force) chatListAutoFit = true;
  if (chatListLayoutFrame) return;
  chatListLayoutFrame = requestAnimationFrame(() => {
    chatListLayoutFrame = 0;
    const sidebar = document.querySelector('.sidebar'); if (!sidebar) return;
    if (window.matchMedia('(max-width:700px)').matches) {
      const limits = chatListHeightLimits(), measured = chatListMeasurements();
      const preferred = chatListAutoFit ? Math.min(measured.all, limits.max) : sidebarHeight;
      sidebarHeight = Math.max(limits.min, Math.min(limits.max, preferred));
      document.documentElement.style.setProperty('--sidebar-height', sidebarHeight + 'px');
      const handle = document.getElementById('sidebarResizer');
      handle?.setAttribute('aria-valuenow', String(sidebarHeight));
      handle?.setAttribute('aria-valuemin', String(limits.min));
      handle?.setAttribute('aria-valuemax', String(limits.max));
      vscode.setState({ ...vscode.getState(), sidebarHeight });
    }
    const first = chatList.querySelector('.chat');
    if (first && chatListAutoFit && chatListMeasurements().first > sidebar.clientHeight + 2) {
      // An exceptionally short viewport can show a chat by scrolling the header.
      sidebar.scrollTop += Math.max(0, first.getBoundingClientRect().top - sidebar.getBoundingClientRect().top - 4);
    }
    positionDeleteToast();
  });
}
function activateRunningList(notifyHost = true) {
  const changed = state.showNonRunning === true;
  state.showNonRunning = false; search.value = '';
  const sidebar = document.querySelector('.sidebar'); if (sidebar) sidebar.scrollTop = 0;
  renderChats(); scheduleChatListLayout(true);
  if (notifyHost && changed) vscode.postMessage({ command: 'setShowNonRunning', enabled: false });
}
window.addEventListener('resize', () => scheduleChatListLayout(true));
window.addEventListener('focus', () => scheduleChatListLayout());
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleChatListLayout(); });
window.addEventListener('message', event => { if (event.data?.type === 'trackerShown' && !state.deleteChat?.busy) activateRunningList(false); });
scheduleChatListLayout(true);
