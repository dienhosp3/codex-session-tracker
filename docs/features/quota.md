# Quota và Usage

Quota lấy từ Codex/Core, không suy ra từ số tin trong lịch sử. Phân biệt cửa sổ 5h, tuần và giới hạn khác theo dữ liệu dịch vụ.

## Khởi động

Chưa có native connection/account/quota đầu tiên thì hiện `---`. Không phát âm báo lỗi giả khi Codex khởi động chậm. Gộp request đang chờ và chạy lượt đọc đầu khi sẵn sàng.

Sau đổi account, kết quả cũ không được gắn vào account mới. Lỗi sau khi đã có mẫu hợp lệ giữ mẫu cũ cùng thông tin chưa cập nhật.

## Cảnh báo và đồ thị

- Chu kỳ dùng ms/s/phút/giờ; 0 là thủ công.
- Cảnh báo theo ngưỡng và mức thay đổi; mẫu cũ, reset lệch nhỏ và reload không được phát lặp.
- Màu quota phải đi cùng số, không chỉ dựa vào màu.
- Các icon thao tác của vùng Usage canh phải; context/quota ở bên trái.
- Đồ thị dùng lịch sử đã đọc; giữ hover và bản nháp cấu hình khi poll nền.

File `usage-YYYY-MM-DD.jsonl` lưu trong globalStorage. Giới hạn số điểm/tuổi mẫu trên đồ thị không đồng nghĩa tự xóa mọi file ngày cũ; xem [storage](../operations/storage.md).

## Mã và kiểm chứng

- [Monitor](../../src/codex_usage.js), [chu kỳ](../../src/codex_usage_cycle.js), [lịch sử](../../src/codex_usage_history.js).
- [Alerts](../../src/codex_usage_alerts.js), [dedup](../../src/codex_usage_notifications.js), [voice](../../src/codex_usage_voice.js).
- Unit: usage, cycle/notifications, history, alerts, voice.
- Edge: layout_controls và các form quota/âm thanh.
