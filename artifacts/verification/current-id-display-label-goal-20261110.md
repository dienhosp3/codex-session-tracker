# ID hiện tại, nhãn hiển thị và Goal một mục tiêu — 10/11/2026

## Yêu cầu đã xác nhận

Người dùng chọn đổi ID của chat hiện tại; chat sau tăng số tiếp theo. Nhãn là
thuộc tính hiển thị riêng. Thêm một câu giải thích mã/nhãn cho Codex; chuyển
Goal chỉ cần mục tiêu.

## Bản 0.12.51

- Tuỳ chọn chat bổ sung Nhãn hiển thị, ID chat hiện tại, Số hiện tại và preview
  chat kế tiếp. Lưu ID sửa prefix native ngay, giữ suffix; không cần chuyển chat
  hoặc dừng lượt. Native UUID vẫn giữ nguyên. ID nhận 1–30 chữ/số Unicode,
  number dùng BigInt và giữ padding, successorSeries được đặt bằng số hiện tại +1.
- Preview phân biệt ID hiện tại với cấu hình ID kế tiếp đã lưu từ bản cũ.
  Draft hộp thoại chuyển tiếp được cập nhật mã/số khi ID hiện tại đã sửa xong.
- Nhãn lưu riêng trong workspaceState của Tracker theo thread ID, hiển thị ở
  danh sách/header/attention và status bar, kế thừa qua handoff. Không gán vào
  native title, không tham gia parseSeries/reservedCodes, không đưa giá trị nhãn
  vào prompt. Để trống để hiện tên gốc; search tìm cả nhãn lẫn tên/ID gốc.
- Dùng cùng khoá với sửa tuỳ chọn và chuyển tiếp. Lỗi lưu hoặc lỗi đổi Auto Allow
  sau rename khôi phục native name và state. ID khác với lúc mở dialog bị từ
  chối để tránh ghi đè ID vừa đổi ở nơi khác.
- Continuation thêm một câu: “Mã ID và nhãn chỉ để nhận diện chat, không đưa
  vào repo.” Áp dụng cho normal/Goal/Plan; nội dung bổ sung giữ nguyên.
- Goal chấp nhận mục tiêu plain text không trống, tối đa 4000 ký tự. Không thêm
  mẫu MỤC TIÊU / HOÀN TẤT KHI. Giữ mục tiêu native cũ và guardrails chống lan man.

## Kiểm chứng

- **455 Node tests đạt**: Unicode 30 ký tự, replace/remove prefix và padding,
  next sequence, label isolation/clear, reload và inheritance, stale ID,
  rollback, lock chống đua với handoff, routing đúng chat, metadata native riêng
  khỏi nhãn, plain Goal và continuation có câu giải thích.
- **5 native smoke scenarios đạt** trên OpenAI extension `26.51021.22027`, CLI
  `0.164.0-alpha.11.1`: rename khi lượt đang active không đổi turn ID hoặc phát
  request model; `[dựÁn2-0025] Original task` → `[dựÁn2-0026] Tiếp tục`, next
  sequence `0027`; nhãn chứa `[FAKE-8888]` không lọt vào title/prompt; Goal nhận
  đúng “Hoàn thành bản sửa Tracker.” và câu giải thích chỉ xuất hiện một lần.
  Có regression manual idle/running, Goal/Plan/Normal và threshold 85.645/85.
  Model chính gpt-6-astra; manual model-selection regression dùng gpt-6.1-sol.
- **Edge thật**, hai bộ kiểm tra ở 1000/520/320px: nhập ID trước khi chuyển,
  chặn ký tự thứ 31, preview tăng số, nhãn literal không tạo HTML, tìm nhãn/ID,
  clear label, tên gốc trong tooltip, cập nhật draft chuyển tiếp, Goal plain
  text, không tràn layout và không page error.
- Syntax và git diff --check đạt. Scratch dùng token thường LEGION\SP3, helper
  ACL/probes đúng SID và dọn cả cây sau test/build. Không gọi model ngoài.

Không đổi ID hay nhãn của chat thật khi chưa được người dùng nhập giá trị.
Các native smoke tests dùng CODEX_HOME riêng và model endpoint loopback.

Provenance: [checkpoint](../checkpoints/current-id-display-label-goal-0.12.51-20261110.json).

## Cài đặt

VSIX `codex-session-tracker-0.12.51.vsix`: 295 entries, SHA256
`96217eadd214ab9df382cd79b8a15b5f29596b994950f368d993a999233a305e`.
CLI đã cài thành công; registry/manifest xác nhận 0.12.51. 292 file payload
bản cài khớp hash VSIX. Scratch build/install đã dọn. Không ép reload giữa
những chat đang chạy; dùng Developer: Reload Window để nạp phiên bản mới.
