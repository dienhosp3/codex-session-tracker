# Sửa vòng lặp chuyển chat tại ngưỡng context — 10/11/2026

## Chẩn đoán đúng chat được cung cấp

Đọc riêng metadata/usage của rollout và entry Tracker trong workspaceState qua
SQLite read-only. Giá trị thực: `709484 / 828400 = 85.64509898599711%`, ngưỡng
`85`, interval `100ms`, Auto resume enabled, continuationMode `goal`, tốc độ
`ultrafast`, model `gpt-6-astra`, effort `ultra`, context preset `900k`.

Không có handoff journal cho chat này. Catalog cache hiện tại chỉ công bố Fast
(`priority`, additional speed `fast`). Gọi lại requireSpeed với chính metadata
đó tái hiện lỗi `Ultrafast chưa khả dụng với model này trong Codex.`

Luồng cũ: preflight tốc độ ném handoffSkipped → xoá entry.handoff → poll kế tiếp
vẫn vượt 85% → tạo pending lại sau 100ms. Lỗi trong readings bị lần đọc kế tiếp
ghi đè, làm trạng thái nhấp nháy và không tiến tới tạo chat.

## Sửa trong 0.12.50

- Chuyển tự động không bị chặn bởi bước kiểm tra tốc độ thừa trước khi dừng.
  Sau khi xác nhận nguồn dừng, chọn tốc độ từ catalog live: giữ tốc độ nếu được
  hỗ trợ; Ultrafast không có thì dùng Fast, hoặc Standard khi Fast cũng không có.
- Lưu tốc độ yêu cầu/thực tế vào journal, dùng cùng tốc độ cho thread/start và
  lượt đầu/Goal activation. Hiện thông báo trên chat nguồn và successor; không
  thay model, Goal, cấu hình reasoning hay quyền. Chọn thủ công vẫn validate
  nghiêm ngặt, không tự đổi tốc độ người dùng vừa chọn.
- Preflight bị bỏ qua giữ một deferred record theo lượt/model/tốc độ/cài đặt,
  giữ lỗi qua poll/reload. Cùng đầu vào không tự thử lại mỗi 100ms. Không tính
  phần trăm tăng dần là một thay đổi để phát lại preflight.
- Lượt mới, cài đặt chuyển thay đổi, bật lại Auto resume, thao tác chuyển thủ
  công hoặc native Goal được kích hoạt phù hợp sẽ cho phép thử lại. Không tự
  khởi động Goal đã paused/hoàn tất; không phát lại handoff đã completed/unknown.
- Owner bridge revision 23 đưa resolver tốc độ và sự kiện Goal tới watcher.

## Kiểm chứng

- **446 Node tests đạt**, gồm 100 lần poll không lặp preflight, không thêm lần
  ghi trạng thái sau lần chặn đầu, reload vẫn giữ lỗi, các cách re-arm hợp lệ,
  strict manual speed và host threshold path không chặn Ultrafast sớm nữa.
- **5 native tests đạt** trên extension OpenAI `26.51021.22027`, CLI
  `0.164.0-alpha.11.1`: tái hiện chính xác usage/ngưỡng của người dùng với Goal
  active + Ultrafast, tạo đúng một successor, `service_tier: priority` thật trên
  request, objective/model/setting Ultra giữ nguyên, Goal nguồn được clear.
  100 lượt kiểm tra tiếp không tạo thêm chat. Có regression Goal/Plan/Normal và
  auto compact/manual compact. Mọi request model đi tới loopback fixture.
- Runtime fixture chuẩn hoá Ultra thành xhigh trên wire ở cả nguồn và đích;
  kiểm tra cả setting `ultra` trong rollout và effort hiệu dụng không đổi,
  không suy luận chỉ từ nhãn giao diện.
- Edge 1000/520/320px: thông báo fallback, lỗi deferred qua render, nút chuyển
  thủ công vẫn dùng được; các tuỳ chọn hiện có và layout không lỗi.
- Syntax checks, git diff --check đạt. Scratch dùng helper đúng SID người dùng,
  token thường, kiểm tra ACL/probes và dọn các thư mục chạy riêng.

Không sửa workspace DB đang được VS Code sử dụng, không tự kích hoạt lại Goal
thật của người dùng, không đổi tốc độ/config của chat nguồn.

Provenance: [checkpoint](../checkpoints/threshold-handoff-loop-0.12.50-20261110.json).

## Cài đặt

VSIX `codex-session-tracker-0.12.50.vsix`, 294 entries, SHA256
`d18bb4752aafc685507b062670f018f3c3f6e1e7d0839eadccfcc07c329ec1db`.
CLI cài thành công và liệt kê 0.12.50. Registry/manifest đúng phiên bản;
291 file payload bản cài khớp hash VSIX. Scratch build/install đã được dọn.
Không ép Reload Window trong khi các chat khác có thể đang chạy.
