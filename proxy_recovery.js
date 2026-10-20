'use strict';

const { randomUUID } = require('node:crypto');
const RECOVERY_TEXT = 'Tiếp tục công việc (nếu còn)';

function createProxyRecovery(options = {}) {
  const clock = options.now || Date.now;
  let plan = options.plan?.schemaVersion === 1 ? structuredClone(options.plan) : null;
  let busy = false;
  let notice = '';
  // An interrupted extension host may have sent the message without saving its ACK.
  for (const task of plan?.tasks || []) {
    if (task.state === 'sending') task.state = 'unknown';
  }
  const save = () => options.save?.(plan ? structuredClone(plan) : null);
  const snapshot = () => ({ busy, notice, pendingCount: plan?.phase === 'watching' ? (plan.tasks || []).filter(task => ['pending', 'sending'].includes(task.state)).length : 0 });

  return {
    snapshot,
    async prepare(observation) {
      if (busy) throw new Error('Đang khôi phục chat; chờ gửi xong trước khi restart proxy.');
      if (!observation?.complete || !Array.isArray(observation.tasks) || !Number.isFinite(observation.checkedAt) || observation.checkedAt > clock() || clock() - observation.checkedAt > 30000) {
        throw new Error('Chưa quét đủ task để lưu trước khi khởi động lại proxy.');
      }
      const previous = plan;
      const now = clock();
      const preserved = (plan?.phase === 'watching' ? plan.tasks || [] : []).filter(task => ['pending', 'unknown', 'sending'].includes(task.state));
      const byThread = new Map(preserved.map(task => [task.threadId, task]));
      for (const task of observation.tasks) {
        if (task.stateKind !== 'running' || !task.threadId) continue;
        const previousTask = byThread.get(task.threadId);
        if (previousTask && previousTask.turnId === task.turnId) continue;
        byThread.set(task.threadId, {
          threadId: task.threadId, turnId: task.turnId || '', cwd: task.cwd || '', file: task.file || '',
          clientUserMessageId: randomUUID(), state: 'pending', attempts: 0, capturedAt: now, nextAttemptAt: now + 5000
        });
      }
      plan = { schemaVersion: 1, phase: 'prepared', startedAt: now, tasks: [...byThread.values()] };
      try { await save(); } catch (error) { plan = previous; throw error; }
      notice = plan.tasks.length ? 'Đã lưu ' + plan.tasks.length + ' chat để kiểm tra sau restart.' : '';
      options.onChange?.();
    },
    async arm() {
      if (!plan) throw new Error('Chưa lưu danh sách task trước restart.');
      const previous = plan.phase;
      plan.phase = 'watching';
      try { await save(); }
      catch (error) { plan.phase = previous; throw error; }
      options.onChange?.();
    },
    async consider(observation) {
      if (busy || plan?.phase !== 'watching' || !observation?.complete || !Array.isArray(observation.roots)) return;
      const now = clock();
      if (now - observation.checkedAt > 30000 || observation.checkedAt > now) return;
      busy = true;
      try {
        for (const task of plan.tasks) {
          if (task.state !== 'pending' || now < task.nextAttemptAt) continue;
          if (now - task.capturedAt > 10 * 60000) { task.state = 'expired'; await save(); continue; }
          const current = observation.roots.find(root => root.threadId === task.threadId);
          if (!current || current.stateKind === 'unknown') continue;
          if (current.turnId && task.turnId && current.turnId !== task.turnId) {
            task.state = 'superseded';
            await save();
            continue;
          }
          if (!['completed', 'error', 'aborted'].includes(current.stateKind)) continue;
          if (!Number.isFinite(current.lastActivity) || current.lastActivity < task.capturedAt - 2000) continue;
          task.state = 'sending';
          task.attempts += 1;
          try { await save(); }
          catch (error) {
            task.state = 'pending';
            task.nextAttemptAt = clock() + 10000;
            throw error;
          }
          try {
            const result = await options.send({ ...task, message: RECOVERY_TEXT });
            if (!result?.turnId) {
              const error = new Error('Thiếu xác nhận lượt chat mới.');
              error.delivery = 'unknown';
              throw error;
            }
            task.state = 'done';
            notice = 'Đã gửi câu tiếp tục vào chat bị ngắt.';
          } catch (error) {
            const safeRetry = ['not_sent', 'rejected'].includes(error.delivery);
            task.state = safeRetry && task.attempts < 6 ? 'pending' : 'unknown';
            task.nextAttemptAt = clock() + 10000;
            notice = task.state === 'unknown' ? 'Chưa rõ tin tiếp tục đã được nhận; giữ trạng thái để tránh gửi trùng.' : 'Chờ kết nối Codex để tiếp tục chat bị ngắt.';
          }
          await save();
        }
      } catch (error) {
        notice = 'Không thể lưu trạng thái khôi phục chat: ' + error.message;
      } finally {
        busy = false;
        options.onChange?.();
      }
    }
  };
}

module.exports = { createProxyRecovery, RECOVERY_TEXT };
