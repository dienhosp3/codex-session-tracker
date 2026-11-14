'use strict';

const MODES = Object.freeze(['normal', 'goal', 'plan']);
const GOAL_TEMPLATE = '';
const GOAL_GUARDRAILS = `PHẠM VI VÀ ĐIỂM DỪNG CỦA GOAL:
- Đọc cuộc trò chuyện được liên kết để xác định yêu cầu đã được người dùng giao, phần đã hoàn thành và phần còn dang dở. Ưu tiên chỉ đạo mới nhất và giữ các ràng buộc, quyền đã được người dùng giao.
- Không coi ý tưởng, đề xuất chưa được chấp thuận hoặc hướng đã bị loại bỏ là nhiệm vụ.
- Chỉ làm phần còn thiếu để đạt mục tiêu đã giao. Chỉ thêm việc phụ nếu đó là điều kiện bắt buộc để đáp ứng yêu cầu đã giao.
- Không tự thêm tính năng, refactor, tối ưu, nâng cấp hay mở rộng kiểm thử ngoài phạm vi. Không lặp lại công việc hoặc kiểm tra đã đạt nếu không có thay đổi mới, lỗi mới hoặc vấn đề chưa giải quyết.
- Khi mục tiêu đã đạt, kết thúc Goal và báo kết quả. Không tự tìm thêm việc để tiếp tục.
- Nếu không đọc được chat cũ hoặc chưa rõ phạm vi/tiêu chí, hỏi người dùng trước khi làm; không tự đoán yêu cầu.`;

function normalizeHandoffMode(value = 'normal') {
  if (!MODES.includes(value)) throw new Error('Chế độ chuyển chat không hợp lệ.');
  return value;
}

function validateGoalText(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Nhập mục tiêu cho Goal.');
  const text = value.trim().normalize('NFC');
  if ([...text].length > 4000) throw new Error('Goal tối đa 4000 ký tự.');
  if (/\[(Kết quả cần hoàn thành|Tiêu chí kiểm chứng được)\]/iu.test(text)) throw new Error('Nhập mục tiêu thực tế cho Goal.');
  return text;
}

function goalDraft(objective) {
  return typeof objective === 'string' ? objective.trim().normalize('NFC') : '';
}

function goalContext(message) { return String(message) + '\n\n' + GOAL_GUARDRAILS; }

module.exports = { MODES, GOAL_TEMPLATE, GOAL_GUARDRAILS, normalizeHandoffMode, validateGoalText, goalDraft, goalContext };
