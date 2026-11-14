# Trạng thái giao tiếp và Gateway

## Ba loại bằng chứng

| Nguồn | Biết được | Không được suy diễn |
| --- | --- | --- |
| Rollout/native owner | Lượt chat, nội dung đã ghi, task chạy/dừng/chờ | Toàn bộ byte HTTP/WebSocket thật |
| CONNECT pass-through | Host, kết nối, chiều byte, timing | Nội dung HTTPS đã giải mã |
| Plaintext/application hook hoặc HTTP hợp lệ | Body/frame/event thực sự quan sát được | Upstream đã dùng steer chỉ vì có ACK cục bộ |

**Tắt Gateway local:** danh sách, lịch sử và trạng thái từ rollout/native vẫn đọc được. Gateway và các hook gửi về nó không còn thu luồng mạng mới. Log cũ vẫn tồn tại và có thể mở lại.

Bật Gateway một mình không bảo đảm có đủ request/response body: cần đúng tuyến traffic và chế độ capture hỗ trợ. Runtime hook có kiểm tra phiên bản/hash; không gắn bừa bản runtime cũ vào Codex mới.

## Giao diện

Phần thu gọn chỉ hiển thị trạng thái online/lỗi và các nút cần thiết. Chi tiết kỹ thuật mở theo yêu cầu. Online dùng đèn xanh nhịp opacity 10–100%, có nhãn truy cập được; không dùng một đoạn chữ dài thay cho trạng thái.

Traffic Monitor có lọc chiều, host, method, endpoint và thời gian. Pause chỉ đóng băng phần trình bày, không làm chậm mạng.

## Lưu dữ liệu

Trace nằm trong globalStorage/gateway và xoay vòng theo giới hạn cấu hình. Raw traffic nằm ở thư mục người dùng chọn, mặc định Documents/Codex Logs. Giới hạn số request trên UI không phải quota dung lượng ổ đĩa. Xem [các loại dữ liệu và cách dọn](../operations/storage.md).

## Mã và kiểm chứng

- [Gateway](../../gateway/index.js), [server](../../gateway/server.js), [state machine](../../gateway/state_machine.js).
- [Traffic logs](../../gateway/traffic_logs.js), [saved traffic](../../gateway/saved_traffic.js), [trace](../../gateway/trace_store.js).
- [Client hook](../../gateway/client_instrumentation.js), [runtime](../../gateway/client_runtime.js), [native hook](../../gateway/native_instrumentation.js).
- Unit: gateway, traffic_logs, traffic_ui, plaintext_stream, client_instrumentation.
- Integration loopback dành riêng cho transport/hook; không dùng phiên chat thật để tạo bằng chứng giả.
