# Codex Session Tracker

Extension VS Code trên Windows để theo dõi chat Codex, context/quota, chuyển tiếp công việc và quản lý tài khoản. Phiên bản nguồn hiện tại: **0.13.4**.

## Bắt đầu

Mở **Codex Tracker** trong VS Code. Chọn chat để xem trạng thái, dùng icon ở đầu chat hoặc ngay trên từng hàng để cấu hình/chuyển tiếp. Biểu tượng tài khoản mở cửa sổ quản lý; nút **?** giải thích trình tự và tác động của liên kết.

Sau khi cài bản cập nhật, reload cửa sổ để nạp mã mới.

## Tài liệu

**[Mục lục theo chức năng](docs/README.md)** là điểm tra cứu chính.

| Cần làm gì | Đọc |
| --- | --- |
| Liên kết BAT, tài khoản và chính sách tự động | [Tài khoản](docs/features/accounts.md) |
| Tạo/chọn/gửi chat | [Chat](docs/features/chats.md) |
| Context, chuyển tiếp, Goal/Plan | [Chuyển tiếp](docs/features/handoff-context.md) |
| Usage và cảnh báo | [Quota](docs/features/quota.md) |
| Âm thanh và thông báo | [Thông báo](docs/features/notifications.md) |
| Gateway tắt còn thấy gì, traffic lưu đâu | [Giao tiếp](docs/features/communication.md), [storage/cache](docs/operations/storage.md) |
| Chẩn đoán ảnh Failed | [Ảnh](docs/features/images.md) |
| Sửa giao diện | [Chuẩn UI/UX](docs/development/ui-ux.md) |
| Tìm đúng module | [Bản đồ mã](docs/architecture/module-map.md) |
| Chạy test, đóng gói | [Kiểm thử](docs/development/testing.md), [phát hành local](docs/development/release.md) |

## Cấu trúc

```text
extension.js        điểm vào VS Code
src/                nghiệp vụ theo module
media/              webview, dialog và tài nguyên sản phẩm
gateway/            transport, capture và traffic logs
chatgpt-sdk/        SDK tích hợp Core
runtime/            nguồn hook, manifest và giấy phép
scripts/            runner/build/bảo trì
test/               unit / ui / integration / fixtures
docs/               tài liệu theo chức năng
artifacts/          checkpoint và kết luận kiểm chứng
dist/               VSIX local, không commit
```

## Kiểm tra nhanh

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ui-test.ps1 -TestFile account_manager_ui.py
node scripts/check-docs.js
```

Runner Windows kiểm chứng quyền scratch bằng tài khoản người dùng và dọn sau chạy. Test live/integration cần đọc hướng dẫn riêng; không tự dùng phiên thật để gửi model.

[Lịch sử chính](docs/history/releases.md) · [Quy tắc repo](AGENTS.md) · [Giấy phép](LICENSE)
