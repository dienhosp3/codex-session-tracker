# Phục hồi lỗi

Phân loại dựa trên lỗi thật và bằng chứng liên quan: quota, xác thực, stream/network, context, model capacity. Không gọi mọi HTTP 429 là hết quota tài khoản.

## Hành vi

- Mặc định tự tiếp tục tắt. Khi bật, có giới hạn lần thử và cửa sổ thời gian.
- Trước resume, xác minh thread/turn còn đúng, không đang chạy, không chờ duyệt/trả lời, không Goal pause.
- Giao nhận chưa rõ không được phát lại. Giữ action ID/receipt và đối soát.
- Compact, chuyển chat, đổi account và restart proxy là thao tác khác nhau, có điều kiện riêng.
- Kết quả chẩn đoán mạng chỉ là tình trạng lúc kiểm tra, không bảo đảm stream tương lai hoàn tất.

## Trạng thái bền vững

State store dùng khóa và ghi bền vững. Không xóa `failure-recovery.json`, `context-handoffs` hoặc `account-automation.v1.json` như cache: chúng có thông tin chống phát lại.

Lỗi parse JSON phải được xác định nguồn file, giữ bản hỏng và dùng chính sách phục hồi rõ ràng. Không sửa bằng cách biến mọi lỗi đọc thành object rỗng.

## Mã và kiểm chứng

- [Classifier](../../src/codex_failures.js), [controller](../../src/codex_failure_recovery.js), [chẩn đoán](../../src/codex_connection_diagnostics.js).
- [Store](../../src/codex_state_store.js), [UI](../../media/failure_recovery.js).
- Unit có mất ACK, turn thay đổi, task hoàn tất, nhiều cửa sổ và giới hạn retry.
- Edge kiểm tra thao tác, trạng thái bận và lỗi trong form.
