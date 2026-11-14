# Kiểm thử

## Phân loại

| Thư mục | Mục đích | Cách chạy |
| --- | --- | --- |
| test/unit | Logic/IPC bằng fixture, hồi quy và phân tích HTML | scripts/test.ps1 |
| test/ui | Edge headless, thao tác và layout thật với dữ liệu kiểm thử | scripts/ui-test.ps1 |
| test/integration | app-server loopback, hook hoặc bản cài/dữ liệu thật có chủ đích | Đọc phần đầu từng script và truyền env yêu cầu |
| test/fixtures | Backend/transport hỗ trợ integration | Không chạy như bộ unit độc lập |

Từ gốc repo:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test.ps1 test/unit/codex_state_store.test.js
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ui-test.ps1 -TestFile account_manager_ui.py
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ui-test.ps1 -TestFile scrollbars_ui.py
```

`npm test` dùng cùng wrapper Windows, không bỏ qua kiểm chứng ACL.

## Scratch và tác động thật

Wrapper xác minh token thường của LEGION\SP3, tạo scratch dưới TEMP/AHUST-Work/codex-session-tracker, cấp FullControl kế thừa, thử tạo/đọc/sửa/đổi tên/xóa, rồi dọn trong finally. Node preload thay cơ chế mkdtemp để không tạo DACL riêng. Test Python nhận `CST_UI_SCRATCH`, không tự dùng TemporaryDirectory.

Đóng browser, socket, worker và process do test tạo trước cleanup. Lỗi dọn phải hiện đường dẫn/nguyên nhân; không nuốt lỗi.

Integration app-server dùng `CST_CODEX_EXTENSION_ROOT` và home cô lập/localhost model fixture. Không dùng credential thật để chạy lượt model thử.

Integration `account_live_ui.py` yêu cầu chủ đích:

- `CST_INSTALLED_EXTENSION`: đúng thư mục Tracker đã cài.
- `CST_LIVE_STORAGE`: đúng globalStorage Tracker cần kiểm chứng.
- `CST_UI_SCRATCH`: scratch đã được helper kiểm chứng.

Nó chạy refresh bằng module bản cài và Core thật; có thể sửa file trạng thái hỏng theo chính sách phục hồi. Nó không đăng nhập, liên kết, đổi account hay gửi model. Không đưa nó vào unit mặc định.

## Giữ/xóa test

Không xóa test chỉ để bộ kiểm thử xanh. Test bị thay thế phải ghi hành vi cũ đã lỗi thời và test hiện tại bảo vệ hành vi tương ứng.

Trang review âm thanh đã hoàn thành và bộ sample offline không phải test sản phẩm. Test dashboard tổng đời cũ có selector/hành vi không còn đúng được thay bằng các suite UI theo chức năng. Giữ hồi quy thread/turn, chống gửi trùng, trạng thái bền vững và quota ngay cả khi tính năng ít thay đổi.

Báo cáo cần ghi phiên bản, loại fixture/live, số pass/fail và giới hạn. Ảnh chụp/log tạm mặc định dọn; chỉ giữ artifact cần bàn giao.
