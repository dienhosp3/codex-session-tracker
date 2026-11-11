# Auto resume OR compact và vòng đời Goal — 10/11/2026

## Kết luận kiểm tra bản cũ 0.12.47

- Đối chiếu ba module handoff/watch/backend trong bản đã cài với mã nguồn:
  khớp byte. Luồng cũ chỉ `thread/goal/set(status: paused)` rồi interrupt lượt;
  không gọi `thread/goal/clear`.
- Đã chạy Codex CLI thật trong CODEX_HOME cô lập, model endpoint loopback:
  hard restart tiến trình, mở lại chat cũ hai lần. Goal vẫn paused và không có
  request model mới. Goal active ở chat kế tiếp tự chạy khi mở lại.
- Goal của từng thread độc lập. Thử A → B → C, clear A/B khi C đang chạy:
  mục tiêu và lượt hiện tại của C không đổi; restart không khôi phục Goal đã clear.
  Clear Goal giữ nguyên lịch sử của chat. Clear riêng lẻ KHÔNG interrupt lượt
  đang chạy: phải pause/interrupt/xác minh trước.

## Bản 0.12.48

- **Auto resume = đạt ngưỡng HOẶC bắt đầu tự compact**. Dùng chung công tắc,
  khoá chuyển tiếp và nhật ký chống gửi trùng; kế thừa sang chat kế tiếp.
- Lắng nghe trực tiếp `item/started` với `contextCompaction` trên kết nối sẵn có.
  Nhận diện compact thủ công từ `thread/compact/start` trên cùng kết nối để bỏ qua.
  Dừng nguồn trước khi đọc catalog/runtime/tree cho chat mới. Model, reasoning,
  tốc độ, context và quyền vẫn đi qua luồng kế thừa đã có.
- Khi nguồn có Goal: pause, interrupt, xác minh lượt dừng; lưu bản mục tiêu trong
  journal; chuẩn bị ngữ cảnh và Goal mới `paused` (nếu chuyển Goal), đọc lại xác
  nhận; kiểm tra nguồn vẫn đúng lượt/Goal; clear đúng thread nguồn và đọc lại phải
  null; rồi mới activate Goal hoặc gửi lượt Plan/Thường.
- Không chạy lượt mới khi chuẩn bị hoặc clear thất bại. Nhật ký completed vẫn
  trả lại cùng chat sau khi Goal nguồn bị clear; trạng thái lỗi/không rõ kết quả
  không tự gửi lại. Không quét xoá các Goal lịch sử từ bản cũ.

## Rủi ro và giới hạn

| Tình huống | Đánh giá / cách xử lý |
|---|---|
| Mở lại Goal cũ paused của 0.12.47 | Không tự chạy trong runtime đã kiểm thử; vẫn có thể được người dùng chủ động resume. |
| Mở lại nguồn đã chuyển bằng 0.12.48 | Goal nguồn đã null; không có Goal cũ để tự kích hoạt lại. Lịch sử vẫn đọc được qua deeplink. |
| Xoá Goal nguồn làm mất Goal kế tiếp | Không xảy ra trong chuỗi ba chat đã thử. Mỗi successor là thread/start riêng, có Goal riêng. |
| Xoá nguồn trước khi lưu Goal mới | Tránh bằng lưu + đọc lại Goal mới paused và journal trước khi clear. |
| Clear thất bại | Nguồn và đích còn paused; đích chưa chạy. Cần kiểm tra lỗi trước khi tiếp tục. |
| Ngắt sau clear, trước activate | Nguồn null, Goal đích vẫn paused và giữ mục tiêu qua restart; có thể cần Resume thủ công. |
| Mất phản hồi sau activate | Giữ kết quả chưa rõ và ID chat để kiểm tra; không tự phát thêm activation hoặc tạo chat trùng. |
| Client khác sửa/resume cùng chat trong lúc chuyển | Có kiểm tra lượt, trạng thái, mục tiêu, createdAt trước clear; API không có compare-and-clear nên không thể bảo đảm tuyệt đối trước thay đổi đồng thời ngay sau lần kiểm tra. |
| Compact đã gửi request trước khi sự kiện tới Tracker | Ngắt ngay khi xử lý sự kiện; không hứa chặn được request đã rời runtime hay hoàn nguyên một compact đã kịp hoàn tất. |
| Tracker/Codex chưa kết nối | Chưa có luồng sự kiện để can thiệp. Chức năng cần owner bridge đang hoạt động. |

## Kiểm chứng

- **433 Node tests đạt**, bao gồm OR/disabled/reload, hai trigger tranh nhau,
  sự kiện trùng, phân biệt manual, host chọn đúng chat/model/effort, thứ tự lưu
  Goal/clear/activate và lỗi không tự chạy đích.
- **9 native smoke tests đạt** trên CLI `0.164.0-alpha.11.1`, từ OpenAI VS Code
  extension `26.51021.22027`; model fixture `gpt-6-astra`, không gọi model ngoài.
  Có 4 kiểm tra vòng đời/restart/lỗi, 3 kiểm tra auto compact/Goal/manual,
  chuỗi Normal → Goal → Goal → Plan → Normal và handoff/permissions/attention.
- Auto compact thật được kích hoạt bằng token usage fixture vượt ngưỡng compact
  native, trong khi mức theo dõi là 2% dưới ngưỡng chuyển 99%. Lượt nguồn kết thúc
  interrupted, compact không completed, chỉ có một successor và giữ Fast/context.
- Edge thật: hộp thoại và điều khiển tại 1000/520/320px, không page error.
- Syntax checks và `git diff --check` theo cấu hình Git của repository đạt.
  Scratch chạy bằng token thường LEGION\SP3, ACL/probes cho thư mục con đạt,
  các thư mục chạy riêng đã được dọn.

Provenance: [checkpoint](../checkpoints/auto-compact-goal-clear-0.12.48-20261110.json).

## Đóng gói và cài đặt

- VSIX `codex-session-tracker-0.12.48.vsix`: 293 entries, các file nguồn và runtime
  khớp hash; SHA256 `f85aa0e182014576556a141826233eb899b3e7f2f9709ca2288ff8617cb3e1ee`.
- VS Code CLI đã cài thành công và liệt kê `local.codex-session-tracker@0.12.48`.
  Registry và manifest bản cài đúng phiên bản; **290 file payload** khớp hash
  với VSIX. Package manifest được so phiên bản vì VS Code bổ sung metadata.
- Scratch cài đặt đã kiểm chứng và dọn. Chưa ép Reload Window để tránh ngắt
  các chat đang chạy; người dùng nạp phiên bản mới khi sẵn sàng.

Tài liệu đối chiếu: [OpenAI App Server](https://learn.chatgpt.com/docs/app-server)
(Goal get/set/clear, interrupt, contextCompaction) và
[Long-running work](https://learn.chatgpt.com/docs/long-running-work)
(Goal riêng từng chat). Những kết luận restart/clear ở trên dựa thêm vào thử nghiệm
runtime, không coi mô tả tài liệu là bảo đảm cho mọi phiên bản tương lai.
