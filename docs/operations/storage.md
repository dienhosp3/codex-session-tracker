# Dữ liệu, cache và dọn dẹp

## Các vùng dữ liệu

| Loại | Vị trí | Ý nghĩa/cách làm mới |
| --- | --- | --- |
| Cache scan/session/runtime profile | RAM trong reader worker | Cache nội dung tối đa 64 MiB theo kích thước JSON; metadata/profile tối đa 2.500 mục mỗi loại; đây không phải trần RAM của cả extension |
| Rollout và database Codex | Codex home của người dùng | Nguồn lịch sử; không phải cache của Tracker |
| Quota history | globalStorage Tracker / usage-YYYY-MM-DD.jsonl | Mẫu lịch sử quota; giới hạn đồ thị không tự xóa mọi ngày cũ |
| Trace gateway | globalStorage Tracker / gateway/gateway-trace*.jsonl | Có xoay vòng main/previous theo cấu hình |
| Raw traffic | Thư mục đã chọn trong Traffic Monitor, mặc định Documents/Codex Logs | Body/event/timeline theo ngày, phiên, backend, request |
| Account state | account-automation.v1.json, .bak, .corrupt | Chính sách/lịch/chống lặp; không xóa như cache |
| Handoff/recovery | context-handoffs, failure-recovery.json | Receipt, chống tạo/gửi lại |
| Context/quyền chat | chat-contexts, chat-permissions | Cấu hình nghiệp vụ của người dùng |
| Ảnh người dùng/ảnh xem trong chat | globalStorage / attachments, retained-images | Lưu bền vững theo hash; không thuộc chính sách dọn log |
| Hàng chờ ảnh | globalStorage / image-queue.json | Nội dung chờ, tham chiếu ảnh, thứ tự và receipt chống gửi lặp |
| Chính sách dọn | globalStorage / storage-maintenance.json | Thời hạn, trần dung lượng, khóa giữa các cửa sổ và kết quả lần dọn gần nhất |
| Client runtime | globalStorage/client-runtime | Executable/bridge được quản lý, không chỉ là cache |
| Core account vault/registry | Data directory của AHUST ChatGPT Core | Tài khoản và liên kết BAT; Tracker không tự dọn |
| Build/test của repo | dist và scratch có helper | Có thể tái tạo; xem quy trình dưới |

Global storage mặc định trên máy Windows:

`%APPDATA%\Code\User\globalStorage\local.codex-session-tracker`

Không đọc hoặc sửa kho account/config của proxy để xử lý cache của Tracker.

## Dữ liệu & dọn dẹp

Mở phần **Giao tiếp → Dữ liệu & dọn dẹp** để đo từng nhóm, xem trước số file/dung lượng và dọn theo chính sách. **Làm mới cache hiển thị** xóa cache reader trong RAM, sau đó dữ liệu được đọc lại; không xóa lịch sử hay cấu hình.

Mặc định tự dọn trace/log **sau 7 ngày hoặc khi tổng vượt 512 MiB**. Kiểm tra tự động sau khi khởi động và mỗi 60 giây. Xóa log hết hạn trước, rồi log hoàn tất cũ nhất đến khi đạt trần. Có thể đổi 1–365 ngày, 64–4096 MiB hoặc tắt tự dọn. Lưu chính sách có thể kích hoạt dọn ngay khi tự dọn đang bật. Chỉnh form chưa lưu sẽ khóa nút dọn để không dùng nhầm chính sách.

Chỉ nhận thư mục request đúng cấu trúc/metadata Tracker, có dấu kết thúc và không thay đổi trong ít nhất 60 giây. Giữ trace hiện tại, request chưa hoàn tất và thư mục có file lạ. Trước xóa, đối chiếu lại tên/kích thước/mtime; nếu đã thay đổi thì bỏ qua. Không theo junction/symlink hoặc quét xóa cả globalStorage, Codex home hay state.vscdb.

File đang ghi hoặc chưa đủ bằng chứng an toàn có thể làm tổng tạm vượt trần; UI báo phần chưa dọn được. Writer tạm ngừng lưu body traffic mới khi hết ngân sách và ghi dấu thiếu dữ liệu, không dừng chat. Trace tiếp tục xoay vòng với ngân sách riêng. `maxRequests` chỉ là giới hạn thu/hiển thị, không thay thế retention.

Ảnh đã gắn vào chat, runtime, tài khoản, lịch sử Codex, quota history, cấu hình và receipt được giữ riêng. Không tự xóa ảnh để đạt 512 MiB. Kết quả dọn ghi số file/byte thực tế, số file bị bỏ qua và đường dẫn/nguyên nhân nếu lỗi.

Module: [bảo trì storage](../../src/codex_storage.js), [dialog](../../media/storage_manager.js), [writer traffic](../../gateway/traffic_logs.js). Hồi quy: [storage](../../test/unit/codex_storage.test.js), [UI chính sách](../../test/ui/workspace_controls_ui.py).

## Dọn repo

- Source, test hiện hành, giấy phép và manifest phải giữ.
- Gói VSIX nằm trong `dist`; chỉ giữ bản còn dùng hoặc bản quay lại có mục đích.
- Checkpoint runtime nhỏ giữ theo yêu cầu provenance; report không thay thế docs chức năng.
- Xem trước bằng `python scripts/cleanup.py`. Chỉ dùng chế độ xóa sau khi đọc đúng danh sách và bảo đảm runtime phục vụ build không bị mất.
- Scratch test/build thuộc helper trong `scripts/scratch.ps1`; dọn ở finally và xác nhận thư mục đã mất.

Nếu công cụ chặn thao tác, phải ghi rõ **policy rejection**; nếu Windows từ chối quyền hoặc process giữ file thì ghi đúng lỗi đó. Không gọi tất cả là Access Denied.
