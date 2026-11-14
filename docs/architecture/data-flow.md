# Luồng dữ liệu

## Theo dõi chat

1. Tracker đọc metadata và rollout của Codex; việc đọc nặng chạy trong worker `session_reader`.
2. Native owner bridge bổ sung trạng thái đang chạy/chờ, account và thao tác cần chính xác theo turn.
3. Controller dựng snapshot; `extension.js` gửi thông điệp `state` cho webview.
4. Webview trình bày trạng thái; chỉ gửi command khi người dùng thực hiện một thao tác.

Không suy ra chat còn chạy chỉ từ mtime. Không coi chọn hàng trong Tracker là bằng chứng Codex đã điều hướng xong.

## Thao tác người dùng

UI → command có thread/request ID → kiểm tra điều kiện hiện tại → native owner hoặc Core → ACK/error tương ứng → cập nhật UI.

ACK cục bộ không chứng minh upstream đã nhận lượt. Nếu giao nhận không rõ, giữ receipt và đối soát; không tự gửi lại, không tự đổi steer thành queue.

Dialog giữ DOM ngoài `#main`. Snapshot nền cập nhật metadata cần thiết; không thay input, tab đang mở hoặc vị trí cuộn.

## Tài khoản

Tracker điều phối giao diện/lịch/chính sách. AHUST ChatGPT Core sở hữu registry BAT, xác minh danh tính/workspace, kho phiên được bảo vệ và quota.

`account.list` và `launcher.list` là hai loại dữ liệu: BAT có sẵn chưa đồng nghĩa tài khoản đã liên kết Codex. UI không biến nhãn BAT thành danh tính đã xác minh.

## Dữ liệu bền vững

`codex_state_store` dùng khóa giữa các extension host, ghi file tạm, flush, rồi thay file chính. Một bản `.bak` hợp lệ được giữ. Lỗi JSON không được coi là dữ liệu rỗng.

Account manager có chính sách phục hồi riêng: giữ byte hỏng tại `.corrupt`, dùng backup hoặc mặc định, dừng tự động hóa và không phát lại tác vụ chuyển/gửi cũ. Người dùng kiểm tra rồi lưu chính sách trước khi chạy tự động tiếp.

## Giao tiếp

Rollout/native event cung cấp trạng thái ứng dụng. Gateway cung cấp bằng chứng mạng khi thực sự có traffic đi qua. Hai nguồn không thay thế nhau; xem [giới hạn quan sát](../features/communication.md).
