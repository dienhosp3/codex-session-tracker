(() => {
  'use strict';

  const token = document.currentScript?.dataset.trackerToken;
  const acquire = window.acquireVsCodeApi;
  if (!token || typeof acquire !== 'function') return;
  let api = null;
  let lastRoute = null;
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

  function readRoute() {
    const root = currentReactTree();
    if (!root) return null;
    const pending = [root];
    let inspected = 0;
    while (pending.length && inspected < 50000) {
      const fiber = pending.pop();
      inspected += 1;
      const value = fiber.memoizedProps?.value;
      if (value && ['POP', 'PUSH', 'REPLACE'].includes(value.navigationType) && typeof value.location?.pathname === 'string') {
        return value.location.pathname;
      }
      if (fiber.sibling) pending.push(fiber.sibling);
      if (fiber.child) pending.push(fiber.child);
    }
    return '';
  }

  function report(force = false) {
    if (!api) return;
    const route = readRoute();
    if (route === null || (!force && route === lastRoute)) return;
    lastRoute = route;
    api.postMessage({ type: 'codex-session-tracker.current-chat', token, route, focused });
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
