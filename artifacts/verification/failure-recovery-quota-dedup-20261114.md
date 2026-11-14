# Tracker 0.12.56 — xử lý lỗi và chống báo quota lặp

## Kết quả triển khai

- Phân loại lỗi context, quota, xác thực, capacity, DNS, mạng và stream bị ngắt.
  Panel của chat lỗi hiển thị hướng dẫn và các thao tác phù hợp. Nút chuyển chat
  dùng hộp thoại hiện có; compact/tiếp tục kiểm tra lại trạng thái native và turn ID.
- Probe độc lập Internet, tuyến dịch vụ và proxy local, không credential, không
  gửi prompt, không lưu body/header phản hồi. DNS/TCP/TLS thất bại được phân biệt
  với HTTP 401/404 của probe không có credential. Tất cả probe có timeout.
- Đối chiếu CH-Relay chỉ đọc lỗi/thời gian/trạng thái trong SQLite. Kết quả chỉ
  tương quan thời gian được ghi rõ là nghi vấn, không được tự compact. Nếu runtime
  không có SQLite, chẩn đoán native/mạng vẫn dùng được. Không sửa CH-Relay binary.
- Tự tiếp tục mặc định tắt, bật riêng ở panel lỗi. Chờ hai probe thành công;
  backoff 5/15/45 giây, tối đa ba lần trong một chuỗi lỗi và mười phút từ lỗi đầu.
  Không tự reset proxy, compact, chuyển chat, xử lý lỗi context/auth/quota/capacity
  bằng tin tiếp tục. Native retry còn active, Goal paused, chờ duyệt, user interrupt,
  turn đã đổi, lịch sử cũ và ACK không rõ đều chặn tự gửi.
- Journal chung giữa các cửa sổ được ghi trước side effect. Thiếu ACK hoặc host
  dừng giữa thao tác giữ trạng thái unknown. Kiểm tra native để đối chiếu, không
  phát lại mù quáng. Lỗi/hoàn tất đến trước ACK được đối chiếu với lượt mới, không
  làm mất bộ đếm giới hạn retry.
- Quota dùng danh tính ổn định tài khoản/cửa sổ. Sai lệch reset tới 60 giây không
  tạo hai baseline độc lập; reset thật qua hạn vẫn nhận diện riêng. Migration
  chọn mẫu mới nhất của dữ liệu cũ, bỏ mẫu đến muộn, im lặng khi chuyển tài khoản,
  reset hoặc gián đoạn mẫu hơn 15 phút.
- Journal thông báo quota dùng chung giữa các extension host, reserve trước âm
  thanh để không phát lặp. Cảnh báo giảm mạnh dựa trên mức giảm mới; âm trong hàng
  chờ được kiểm tra lại với mẫu hiện tại, tuổi sự kiện và công tắc âm thanh.
  WAV phát từ bộ nhớ qua stdin, không tạo thư mục tạm riêng.
- Bao gồm sửa độ trễ hộp xác nhận xoá của 0.12.55.

## Kiểm chứng

- Full Node suite: **506 passed, 0 failed**. Bao gồm hai cửa sổ cùng thông báo/gửi,
  reload, reset lệch một giây, dữ liệu muộn, hàng chờ âm thanh, mất ACK, turn đã đổi,
  Goal paused, offline, giới hạn ba lần, và lỗi/hoàn tất đến trước start ACK.
- Headless Edge: `failure_recovery_ui.py` đạt 320/520/1000 px; `chat_feedback_ui.py`
  đạt sáu viewport. Không có page error, không có tràn ngang, action đúng thread/turn,
  nút bị khoá khi thiếu ACK. Checkbox auto không giữ giao diện ở trạng thái cũ.
- Replaying **391 mẫu quota thực** (chỉ metadata, không phát âm thanh): evaluator
  cũ phát sáu sự kiện, gồm ba lần báo trong khi số hiển thị không đổi và một lần
  cảnh báo lớn từ số cũ. Evaluator mới phát bốn sự kiện, **0 lần báo khi không đổi,
  0 cảnh báo lớn từ số cũ**. Khác biệt tổng số gồm nhận diện/migration/reset đúng,
  không chỉ xoá sự kiện một cách cơ học.
- Chạy chính module probe mới trên máy: hai đích độc lập HTTP 200, OpenAI
  `/v1/models` HTTP 401, proxy local `/v1/models` HTTP 401; kết luận reachable.
  Không gửi request sinh nội dung. Module đọc relay nhận diện sáu lỗi context
  khớp chuỗi lỗi 02:27–02:28 đã điều tra, confidence `correlated`.
- Probe TCP/HTTP thật trong loopback kiểm tra 401, 404, từ chối kết nối, timeout
  và không lưu body. SQLite fixture kiểm tra không đọc prompt và từ chối tương
  quan mơ hồ. RPC của các thao tác khôi phục được kiểm thử với backend giả lập;
  không compact, tiếp tục hay restart proxy trên chat thật trong kiểm thử.
- Syntax checks và `git diff --check` đạt. Mọi test/build/UI scratch dùng token
  thường LEGION\SP3, ACL kế thừa và FullControl; access probe và cleanup đều đạt.
- [Runtime checkpoint](../checkpoints/failure-recovery-quota-dedup-0.12.56-20261114.json):
  OpenAI extension 26.51021.22027, bundled CLI 0.164.0-alpha.11.1. Không suy ra
  runtime của mọi rollout từ phiên bản extension.

Phần xử lý sau lỗi chạy ở Tracker. Nó không sửa giới hạn context thật của model,
không thay config context toàn máy và không ngăn năm retry nội bộ đã xảy ra trước
khi Codex kết thúc lượt với lỗi. Khôi phục vẫn cần kết nối native tương thích.

## Đóng gói và cài đặt

- VSIX 0.12.56: **304 entries**, mọi hash nguồn/runtime được xác minh.
  SHA256: `2b0c7277b62de8da8410768bfb33496d629b1b46d360ab10cfe11814689343c4`.
- VS Code CLI báo cài thành công. Registry và package manifest đều là 0.12.56;
  **301 tệp payload đã cài** khớp hash VSIX. `package.json` do VS Code bổ sung
  metadata được kiểm tra version riêng.
- Installer chạy với token thường, scratch có ACL/probe và đã dọn sạch. VSIX
  0.12.55 do lượt trước tạo đã được thay thế và dọn sau khi xác minh 0.12.56.
- Cửa sổ đang chạy cần **Developer: Reload Window** để nạp bản mới. Không ép
  reload hay chiếm focus. Không commit, push hoặc publish.
