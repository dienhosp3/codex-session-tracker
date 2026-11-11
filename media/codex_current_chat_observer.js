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
      if (request?.type === 'implementPlan' && (!props.hostId || props.hostId === 'local') &&
          /^[A-Za-z0-9_-]{1,200}$/.test(props.conversationId || '') && /^[A-Za-z0-9_-]{1,200}$/.test(request.turnId || '')) {
        plans.push({ threadId: props.conversationId, turnId: request.turnId });
      }
      if (fiber.child) pending.push(fiber.child);
    }
    const threadId = /^\/local\/([A-Za-z0-9_-]{1,200})\/?(?:[?#].*)?$/.exec(route)?.[1];
    return { route, planTurnId: plans.find(plan => plan.threadId === threadId)?.turnId || '' };
  }

  function report(force = false) {
    if (!api) return;
    const ui = readUiState();
    if (ui === null || (!force && ui.route === lastRoute && ui.planTurnId === lastPlanTurnId)) return;
    const { route, planTurnId } = ui;
    const resolvedPlanTurnId = route === lastRoute && lastPlanTurnId && !planTurnId ? lastPlanTurnId : '';
    lastRoute = route;
    lastPlanTurnId = planTurnId;
    api.postMessage({ type: 'codex-session-tracker.current-chat', token, route, focused, planTurnId, resolvedPlanTurnId });
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
  window.addEventListener('pagehide', () => {
    observer.disconnect();
    if (timer !== null) window.clearTimeout(timer);
  }, { once: true });
})();
