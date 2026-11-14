# Tài liệu Codex Session Tracker

Đọc trang chức năng liên quan trước khi sửa mã. README ở gốc chỉ là điểm vào; các trang dưới đây mô tả hành vi hiện tại, dữ liệu và đường kiểm chứng.

## Theo chức năng

| Công việc | Tài liệu |
| --- | --- |
| Tài khoản, Chrome BAT, quota dự phòng, đổi phiên | [Quản lý tài khoản](features/accounts.md) |
| Danh sách, chọn chat, tạo chat, gửi và dừng | [Chat và điều hướng](features/chats.md) |
| Context, compact, chuyển tiếp, Goal/Plan | [Chuyển tiếp và context](features/handoff-context.md) |
| Usage, chu kỳ quota, đồ thị, cảnh báo | [Quota và Usage](features/quota.md) |
| Âm thanh, câu hỏi, kế hoạch, giữ máy thức | [Thông báo và âm thanh](features/notifications.md) |
| Gateway, traffic, hook, mức độ quan sát | [Trạng thái giao tiếp](features/communication.md) |
| Stream lỗi, thử lại, chống gửi trùng | [Phục hồi lỗi](features/recovery.md) |
| Ảnh đính kèm và ảnh trong lịch sử | [Ảnh](features/images.md) |

## Phát triển và vận hành

- [Bản đồ module](architecture/module-map.md) và [luồng dữ liệu](architecture/data-flow.md).
- [Chuẩn UI/UX](development/ui-ux.md): đọc trước mọi thay đổi giao diện.
- [Kiểm thử](development/testing.md), [đóng gói và cài đặt](development/release.md).
- [Dữ liệu, cache và dọn dẹp](operations/storage.md), [chẩn đoán lỗi](operations/troubleshooting.md).
- [Lịch sử thay đổi chính](history/releases.md). Checkpoint runtime giữ riêng trong [artifacts/checkpoints](../artifacts/checkpoints/).

## Quy ước

Tài liệu tính năng phải có: hành vi người dùng, tác động của thao tác, trạng thái lỗi, dữ liệu lưu, module và test chịu trách nhiệm. Đổi hành vi thì sửa trang tương ứng trong cùng lượt. Kết quả một lần chạy nằm trong báo cáo verification, không chép vào hướng dẫn chung như một bảo đảm vĩnh viễn.
