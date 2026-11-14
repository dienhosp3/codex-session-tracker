# Lịch sử thay đổi chính

| Mốc | Nội dung |
| --- | --- |
| 0.13.4 | Sắp xếp source/UI/test/docs; UI gọn và đồng bộ, composer hai nút/dòng; paste/đính kèm/Gửi sau có ảnh; sáu mức context; đổi ID theo họ chat; dọn trace/log 7 ngày/512 MiB và cache RAM |
| 0.13.3 | Hướng dẫn ?, chia rõ chọn BAT và cách liên kết |
| 0.13.2 | Phục hồi state NUL/JSON hỏng, flush + backup; icon tài khoản/Deactive |
| 0.13.1 | Account modal ổn định, draft và ACK lưu, danh sách gói/quota |
| 0.13.0 | Core account/quota/Work, readiness, tối ưu danh sách, OK/X |
| 0.12.x | Native owner/steer, context/handoff, Goal/Plan, âm thanh, quota, gateway/traffic |

Các checkpoint trước đây nằm trong [artifacts/checkpoints](../../artifacts/checkpoints/). Dùng tài liệu chức năng để biết hành vi hiện tại; release note cũ không phải contract mới.

## Dọn cấu trúc

Module nghiệp vụ chuyển vào src; dashboard/traffic template chuyển vào media; test tách unit/ui/integration/fixtures. Import, asset path, manifest đóng gói và runner được cập nhật cùng nhau.

Đã bỏ trang review âm thanh độc lập cùng test riêng và test dashboard monolithic đã lỗi thời. Bộ kiểm thử theo chức năng hiện tại thay các kỳ vọng UI cũ. Packager PowerShell dùng chung manifest thay script Bash chép file thủ công. Inventory dọn từ 2026-10 không còn là danh sách hiện hành.
