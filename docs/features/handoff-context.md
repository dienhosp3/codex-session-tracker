# Context và chuyển tiếp

## Theo dõi

Vòng context bật theo dõi riêng từng chat. Ngưỡng 1–99%, mặc định 80%. Chu kỳ đọc log cục bộ không phải lời gọi model hoặc quota.

Thiếu số liệu hợp lệ thì hiện dấu chưa biết và không tự dừng. Context dùng số token và cửa sổ context của đúng phiên.

Tạo chat và chuyển tiếp dùng chung sáu lựa chọn context: **mặc định của model, 400K, 550K, 700K, 900K, Tự đặt (K)**. UI hiển thị giá trị mặc định theo model và chỉ cho chọn mức khả dụng. Cấu hình 600K cũ được giữ dưới dạng tự đặt 600K; không âm thầm đổi giá trị. Ô tự đặt yêu cầu số nguyên dương và chờ backend xác nhận khả năng hỗ trợ.

## Chuyển sang chat mới

1. Kiểm tra đúng thread, turn, quyền và chế độ nguồn.
2. Dừng chat/Goal theo chính sách và chờ xác nhận cả tác vụ con đã dừng.
3. Chờ khoảng thời gian đã cấu hình; nếu nguồn tiếp tục chạy thì không tự tạo successor.
4. Tạo thread cùng workspace, model và quyền phù hợp; lưu receipt trước khi gửi.
5. Gửi yêu cầu tiếp tục và kích hoạt chế độ Thường/Goal/Plan đã chọn.

Deeplink về thread cũ là tham chiếu lịch sử, không phải fork toàn bộ context. Không được hứa rằng ảnh hoặc file nháp của thread cũ tự xuất hiện trong thread mới. Xem [ảnh](images.md).

## Chống lặp và phục hồi

Journal trong `context-handoffs` giữ các mốc tạo/gửi giữa cửa sổ và qua reload. Mất ACK phải đối soát. Nếu successor đã tạo, dùng **Mở chat kế tiếp**; không tạo hoặc gửi lại vô điều kiện.

Goal đang pause, chat chờ approval/câu trả lời và kết quả chưa rõ không được tự resume. Auto Allow chỉ áp dụng đúng phạm vi đã cấu hình; không suy diễn thiếu quyền nguồn thành toàn quyền.

## Mã và kiểm chứng

- [Watcher](../../src/codex_context_watch.js), [handoff](../../src/codex_context_handoff.js), [compact](../../src/codex_context_compact.js).
- [Form](../../src/codex_handoff_form.js), [chế độ](../../src/codex_handoff_modes.js), [quyền](../../src/codex_thread_permissions.js).
- [Dialog](../../media/handoff_dialog.html), [UI](../../media/handoff_dialog.js).
- Unit: context/handoff/manual-handoff/permissions.
- Edge: handoff_dialog, context_watch, speed_proxy.
- Integration: app-server loopback fixture, không sử dụng quota thật.
