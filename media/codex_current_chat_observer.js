(() => {
  'use strict';

  const token = document.currentScript?.dataset.trackerToken;
  const acquire = window.acquireVsCodeApi;
  if (!token || typeof acquire !== 'function') return;
  let api = null;
  let lastRoute = null;
  let lastPlanTurnId = '';
  let timer = null;
  let focused = document.hasFocus();
  let interactions = [];
  const reportedInputs = new Set();
  const submittedPlans = new Set();

  async function implementPlan(message) {
    if (message?.type !== 'codex-session-tracker.implement-plan' || message.token !== token || !api) return;
    const reply = (ok, error) => api.postMessage({ type:'codex-session-tracker.plan-result', token, requestId:message.requestId, ok, error });
    const ui = readUiState();
    if (ui?.route !== '/local/' + message.threadId || ui.planTurnId !== message.turnId) return reply(false, 'Kế hoạch không còn chờ trong đúng chat.');
    const key = message.threadId + ':' + message.turnId;
    if (submittedPlans.has(key)) return reply(false, 'Đã gửi yêu cầu; chờ Codex xác nhận.');
    const pending = [currentReactTree()]; let inspected = 0, handler;
    while (pending.length && inspected++ < 50000) {
      const node = pending.pop(); if (!node) continue;
      if (node.sibling) pending.push(node.sibling);
      if (node.tag === 22 && node.memoizedProps?.mode === 'hidden') continue;
      const props = node.memoizedProps;
      if (props?.isPlanMode === true && typeof props.onSubmit === 'function' && props.questionAndOptions?.length === 1 &&
          props.questionAndOptions[0]?.options?.some(option => option.id === 'implement-plan')) {
        for (let parent = node.return, depth = 0; parent && depth++ < 100; parent = parent.return) {
          const owner = parent.memoizedProps;
          if (owner?.conversationId === message.threadId && (!owner.hostId || owner.hostId === 'local') &&
              owner.pendingRequest?.type === 'implementPlan' && owner.pendingRequest.turnId === message.turnId) { handler = props.onSubmit; break; }
        }
      }
      if (node.child) pending.push(node.child);
    }
    if (!handler) return reply(false, 'Phiên bản Codex chưa cung cấp nút triển khai tương thích.');
    submittedPlans.add(key);
    try { await handler([{ selectedOptionId:'implement-plan' }]); reply(true); schedule(); }
    catch { reply(false, 'Chưa xác nhận được kết quả triển khai; kiểm tra chat trước khi thử lại.'); }
  }
  window.addEventListener('message', event => implementPlan(event.data));

  function inputId(value) {
    if (typeof value !== 'string') return '';
    try {
      const parts = JSON.parse(value);
      return Array.isArray(parts) && parts.length === 3 && parts[0] === 'request_user_input_async' &&
        typeof parts[1] === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(parts[1]) && Number.isSafeInteger(parts[2]) && parts[2] >= 0 ? JSON.stringify(parts) : '';
    } catch { return ''; }
  }

  function inputGroup(fiber) {
    const props = fiber.memoizedProps;
    if (!Array.isArray(props?.questions) || !Number.isInteger(props.questionIndex) ||
        typeof props.onSkip !== 'function' || typeof props.onSubmit !== 'function') return null;
    const ids = props.questions.map(q => inputId(q.id));
    if (!ids.length || ids.some(id => !id) || !ids[props.questionIndex]) return null;
    for (let parent = fiber.return, depth = 0; parent && depth < 100; parent = parent.return, depth++) {
      const key = parent.memoizedProps?.questionKey;
      if (key?.hostId === 'local' && /^[A-Za-z0-9_-]{1,200}$/.test(key.threadId || '') && ids.includes(inputId(key.itemId))) {
        return { threadId: key.threadId, ids, selectedId: ids[props.questionIndex], submitting: props.isSubmitting === true };
      }
    }
    return null;
  }

  // Read committed native question state only. No answers/text leave the webview.
  function resolvedInput(fiber) {
    const key = fiber.memoizedProps?.questionKey, id = inputId(key?.itemId);
    if (!id || key.hostId !== 'local' || !/^[A-Za-z0-9_-]{1,200}$/.test(key.threadId || '')) return null;
    const candidates = [];
    for (let hook = fiber.memoizedState, count = 0; hook && count < 100; hook = hook.next, count++) {
      candidates.push(hook.memoizedState, hook.memoizedState?.value);
    }
    for (const row of fiber.updateQueue?.memoCache?.data || []) if (Array.isArray(row)) candidates.push(...row);
    return candidates.some(state => state?.question?.id === key.itemId && typeof state.isSubmitting === 'boolean' &&
      (state.isSkipped === true || typeof state.lastSubmission === 'string')) ? { threadId: key.threadId, id } : null;
  }

  function currentReactTree() {
    const container = document.getElementById('root') || document.getElementById('app');
    if (!container) return null;
    const rootKey = Object.getOwnPropertyNames(container).find(key => key.startsWith('__reactContainer$'));
    let fiber = rootKey ? container[rootKey] : null;
    if (!fiber) {
      const element = container.firstElementChild;
      const fiberKey = element && Object.getOwnPropertyNames(element).find(key => key.startsWith('__reactFiber$'));
      fiber = fiberKey ? element[fiberKey] : null;
      while (fiber?.return) fiber = fiber.return;
    }
    return fiber?.stateNode?.current || null;
  }

  function readUiState() {
    const root = currentReactTree();
    if (!root) return null;
    const pending = [root];
    const plans = [];
    const inputs = [], resolved = [];
    let route = '';
    let inspected = 0;
    while (pending.length && inspected < 50000) {
      const fiber = pending.pop();
      inspected += 1;
      if (fiber.sibling) pending.push(fiber.sibling);
      if (fiber.tag === 22 && fiber.memoizedProps?.mode === 'hidden') continue;
      const value = fiber.memoizedProps?.value;
      if (!route && value && ['POP', 'PUSH', 'REPLACE'].includes(value.navigationType) && typeof value.location?.pathname === 'string') {
        route = value.location.pathname;
      }
      const props = fiber.memoizedProps, request = props?.pendingRequest;
      const group = inputGroup(fiber), answer = resolvedInput(fiber);
      if (group) inputs.push(group);
      if (answer) resolved.push(answer);
      if (request?.type === 'implementPlan' && (!props.hostId || props.hostId === 'local') &&
          /^[A-Za-z0-9_-]{1,200}$/.test(props.conversationId || '') && /^[A-Za-z0-9_-]{1,200}$/.test(request.turnId || '')) {
        plans.push({ threadId: props.conversationId, turnId: request.turnId });
      }
      if (fiber.child) pending.push(fiber.child);
    }
    const threadId = /^\/local\/([A-Za-z0-9_-]{1,200})\/?(?:[?#].*)?$/.exec(route)?.[1];
    return { route, planTurnId: plans.find(plan => plan.threadId === threadId)?.turnId || '',
      inputs: inputs.filter(group => group.threadId === threadId), resolved: resolved.filter(answer => answer.threadId === threadId) };
  }

  function report(force = false) {
    if (!api) return;
    const ui = readUiState();
    if (ui === null) return;
    const resolved = ui.resolved.map(answer => answer.id);
    interactions = interactions.filter(action => {
      if (action.route !== ui.route || Date.now() > action.expiresAt) return false;
      const group = ui.inputs.find(group => group.ids.some(id => action.ids.includes(id)));
      if (action.skip || action.escape && group?.selectedId !== action.selectedId) resolved.push(action.selectedId);
      else if (!group) resolved.push(...action.ids);
      else return group.submitting; // A failed send/ordinary navigation within the form is still pending.
      return false;
    });
    const resolvedInputIds = [...new Set(resolved)].filter(id => !reportedInputs.has(ui.route + ':' + id));
    if (!force && !resolvedInputIds.length && ui.route === lastRoute && ui.planTurnId === lastPlanTurnId) return;
    const { route, planTurnId } = ui;
    const resolvedPlanTurnId = route === lastRoute && lastPlanTurnId && !planTurnId ? lastPlanTurnId : '';
    lastRoute = route;
    lastPlanTurnId = planTurnId;
    api.postMessage({ type: 'codex-session-tracker.current-chat', token, route, focused, planTurnId, resolvedPlanTurnId,
      ...(resolvedInputIds.length ? { resolvedInputIds } : {}) });
    for (const id of resolvedInputIds) reportedInputs.add(route + ':' + id);
  }

  function observeInputAction(event) {
    if (event.type === 'keydown' && !['Enter', 'Escape'].includes(event.key)) return;
    const button = event.target?.closest?.('button');
    if (event.type === 'click' && (!button || button.disabled)) return;
    const element = button || event.target;
    const fiberKey = element && Object.getOwnPropertyNames(element).find(key => key.startsWith('__reactFiber$'));
    let group;
    for (let fiber = fiberKey ? element[fiberKey] : null, depth = 0; fiber && depth < 100; fiber = fiber.return, depth++) {
      group = inputGroup(fiber);
      if (group) break;
    }
    if (!group || group.submitting) return;
    const ui = readUiState();
    if (!ui || /^\/local\/([A-Za-z0-9_-]{1,200})\/?(?:[?#].*)?$/.exec(ui.route)?.[1] !== group.threadId) return;
    // DOM fibers can reference the alternate tree after a React commit.
    group = ui.inputs.find(current => current.threadId === group.threadId && current.ids.some(id => group.ids.includes(id)));
    if (!group || group.submitting) return;
    interactions.push({ ...group, route: ui.route, expiresAt: Date.now() + 30000,
      escape: event.type === 'keydown' && event.key === 'Escape',
      skip: Boolean(button?.hasAttribute('data-request-input-dismiss')) && event.type === 'click' });
    // Skip is a local action. Successful submission closes the native form;
    // failed submission leaves it present. Navigation/blur never resolve it.
    schedule();
  }

  function schedule() {
    if (timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      report();
    }, 100);
  }

  // Codex still acquires and receives its own original API exactly once.
  window.acquireVsCodeApi = function(...args) {
    const result = acquire.apply(this, args);
    api = result;
    schedule();
    return result;
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
  window.addEventListener('focus', () => {
    focused = true;
    report(true);
  });
  window.addEventListener('blur', () => { focused = false; });
  window.addEventListener('click', observeInputAction, true);
  window.addEventListener('keydown', observeInputAction, true);
  window.addEventListener('pagehide', () => {
    observer.disconnect();
    if (timer !== null) window.clearTimeout(timer);
    window.removeEventListener('click', observeInputAction, true);
    window.removeEventListener('keydown', observeInputAction, true);
  }, { once: true });
})();
