'use strict';

const LABELS = {
  rate_limit: 'Giới hạn tần suất tạm thời',
  context: 'Vượt giới hạn context', offline: 'Mất kết nối Internet', dns: 'Lỗi phân giải DNS',
  proxy: 'Proxy cục bộ không phản hồi', upstream: 'Không kết nối được dịch vụ',
  auth: 'Lỗi đăng nhập hoặc quyền truy cập', quota: 'Hết hạn mức hoặc quá nhiều yêu cầu',
  capacity: 'Dịch vụ đang quá tải', stream: 'Luồng phản hồi chưa hoàn tất', unknown: 'Lượt chat gặp lỗi'
};
const GUIDANCE = {
  rate_limit: 'Chờ Retry-After và kiểm tra quota; HTTP 429 không tự chứng minh tài khoản đã hết hạn mức.',
  context: 'Dừng thử lại cùng nội dung. Compact hoặc chuyển chat; ngưỡng context cấu hình không làm tăng giới hạn thật của dịch vụ.',
  offline: 'Chờ mạng ổn định trở lại. Không cần reset proxy khi Internet của máy đang mất.',
  dns: 'Kiểm tra DNS và đường mạng đang dùng; không tự đổi DNS toàn máy.',
  proxy: 'Kiểm tra proxy cục bộ. Chỉ restart khi đã xét các chat khác đang chạy.',
  upstream: 'Internet vẫn hoạt động nhưng tuyến tới dịch vụ chưa thông. Kiểm tra upstream/proxy/VPN.',
  auth: 'Kiểm tra phiên đăng nhập và quyền truy cập. Không thử lại liên tục.',
  quota: 'Chờ hạn mức hoặc thời gian Retry-After. Reset mạng không khắc phục hạn mức.',
  capacity: 'Chờ dịch vụ phục hồi; có thể thử lại có giới hạn.',
  stream: 'Chưa nhận được sự kiện hoàn tất. Kiểm tra kết nối và lỗi upstream trước khi tiếp tục.',
  unknown: 'Kiểm tra lỗi gốc và trạng thái lượt trước khi tiếp tục.'
};

function classifyFailure(error) {
  const message = String(typeof error === 'string' ? error : error?.message || '').slice(0, 2000);
  const info = typeof error === 'object' ? error?.codexErrorInfo || error?.codex_error_info || error?.code || '' : '';
  const text = message + ' ' + JSON.stringify(info);
  let category = 'unknown';
  if (/context[_ ]?(?:length|window)[_ ]?(?:exceeded|exce)|exceeds the context window|context window.*exceed|maximum context length/i.test(text)) category = 'context';
  else if (/unauthorized|\b40[13]\b|authentication|invalid.api.key/i.test(text)) category = 'auth';
  else if (/usageLimitExceeded|usage_limit|quota.exceeded/i.test(text)) category = 'quota';
  else if (/\b429\b|rate.limit|too.many.requests/i.test(text)) category = 'rate_limit';
  else if (/server.?overloaded|at capacity|\b50[234]\b/i.test(text)) category = 'capacity';
  else if (/ENOTFOUND|EAI_AGAIN|dns error|name resolution/i.test(text)) category = 'dns';
  else if (/network.*unreachable|ENETUNREACH|ENETDOWN/i.test(text)) category = 'offline';
  else if (/stream.*disconnect|stream closed|response\.completed|ECONNRESET|ETIMEDOUT|connection.*(?:closed|reset)|runtime.*(?:exit|unavailable)/i.test(text)) category = 'stream';
  return { category, message, label: LABELS[category], guidance: GUIDANCE[category], confidence: 'native' };
}

module.exports = { classifyFailure, LABELS, GUIDANCE };
