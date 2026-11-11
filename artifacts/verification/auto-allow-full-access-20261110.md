# Auto Allow và toàn quyền cho chat mới — 10/11/2026

## Nguyên nhân xác nhận

Chat được người dùng cung cấp có rollout từ CLI `0.164.0-alpha.11.1`, originator
`codex_vscode`, `approval_policy: on-request`, profile `:read-only`, reviewer
`user`. Luồng tạo chat mới 0.12.48 không truyền quyền riêng nên nhận mặc định
read-only của app-server. Đây là nguyên nhân phải xin phép khi ghi/sửa file.
Chỉ đọc các bản ghi quyền/metadata của đúng chat, không đọc auth hoặc sửa rollout.

## Bản sửa 0.12.49

- Chat hoàn toàn mới từ Tracker gửi `approvalPolicy: never`, reviewer `user`,
  `permissions: :danger-full-access` ở cả `thread/start` và lượt đầu. Bật sẵn
  Auto Allow theo đúng yêu cầu mới của người dùng; không thay đổi config chung.
- Thêm **Auto Allow** trong **Tuỳ chọn chat**, lưu theo thread ID ở
  `chat-permissions`. Bật/tắt, reload/mở lại và kế thừa sang successor đều giữ
  đúng phạm vi chat. Bản quyền trước đó được lưu để khôi phục khi tắt.
- Native `thread/settings/update` không thay quyền của lượt đang chạy. Đã thử
  một lượt read-only với hai lệnh liên tiếp: cập nhật native đơn thuần vẫn hỏi
  cả hai lần. Controller Auto Allow vì vậy xử lý đúng hai loại yêu cầu native
  Terminal và sửa file bằng quyết định `accept` cho từng request, chỉ trong
  chat đã bật. Gồm yêu cầu đang chờ đã được controller quan sát.
- Không trả lời hộ câu hỏi, Plan implementation, MCP/app approvals, yêu cầu
  cấp quyền hoặc tự tạo policy amendment. Không approve lại request đã được
  người dùng trả lời/resolved hoặc lượt đã kết thúc.
- Khi tắt, dừng tự duyệt yêu cầu mới ngay. Native permissions khôi phục từ lượt
  tiếp theo; không thu hồi lệnh đã thực hiện hay đổi quyền giữa lượt đang chạy.
  Chat tạo mới trở về workspace-write/on-request khi người dùng tắt Auto Allow.
- Nếu native policy từ chối hoặc lưu thất bại, trả lỗi; thất bại lưu quyền có
  rollback native. Các tuỳ chọn khác được rollback khi đổi quyền bị từ chối.
- Bridge revision 22; wrappers gửi/nhận được tháo đúng thứ tự khi dispose.

## Kiểm chứng

- **441 Node tests đạt**: store/reload, phạm vi ID, pending/duplicate/manual
  replies, các loại yêu cầu không được tự duyệt, bật/tắt và stale UI settings,
  rollback khi lưu thất bại, host chọn đúng chat dù đang xem chat khác.
- **7 native tests đạt** dùng OpenAI extension `26.51021.22027`, CLI
  `0.164.0-alpha.11.1`, model `gpt-6-astra` với endpoint loopback:
  - Lượt cũ read-only: pending approval và lệnh tiếp theo được tự cho phép sau
    khi bật; cả hai lệnh thực thi với exit code 0.
  - Chat mới: ghi file thật ngay lượt đầu, không requestApproval; profile full
    access và approval never được xác nhận từ rollout.
  - Restart/resume và turn/start mang settings read-only cũ vẫn giữ quyền đã
    chọn; chat không liên quan vẫn chờ người dùng duyệt.
  - Tắt rồi restart: khôi phục workspace-write/on-request, yêu cầu duyệt vẫn
    chờ; nội dung config.toml toàn cục không thay đổi.
  - Goal successor kế thừa Auto Allow và backup; thay ở đích không đổi nguồn.
  - Regression: auto compact ở Normal/Goal, compact thủ công và chuỗi
    Normal → Goal → Goal → Plan → Normal.
- Edge ở 1000/520/320px: checkbox mới, lưu đúng ID, mở lại, khác biệt giữa chat,
  chống ACK cũ/bấm trùng, đóng không lưu, không tràn và không page error.
- Syntax checks và `git diff --check` đạt. Scratch dùng token thường LEGION\SP3,
  ACL/probes thư mục con đạt và tất cả thư mục scratch đã dọn.

Không gọi model bên ngoài trong các bài kiểm chứng. Chỉ probe thao tác vô hại
hoặc file trong scratch; không tự chạy lệnh đang hỏi của chat người dùng.

## Cài đặt và chat được chỉ định

- VSIX 0.12.49 có 294 entries, source/runtime hashes verified; SHA256
  `cec569a5c6b6c27e0210f3f1f3d4ac9e70987527695c6a281f8d69b6f6cfccaf`.
- VS Code CLI cài thành công; registry/manifest xác nhận 0.12.49 và 291 file
  payload khớp VSIX. Scratch build/install đã kiểm chứng quyền và dọn.
- Đã lưu Auto Allow = true cho đúng ID chat người dùng cung cấp, đọc lại từ
  store mới để xác nhận; không đổi preference của chat khác. Khi lưu, metadata
  native mới nhất của chat đã chuyển sang never/danger-full-access trong thời
  gian làm việc; giữ đúng quyền mới nhất đó làm bản khôi phục, không ghi lại
  rollout hoặc tự ép nó về trạng thái read-only đã quan sát ban đầu.
- Phiên extension đang chạy cần Reload Window để nạp controller mới. Không ép
  reload hoặc tự chạy lại task đang làm; preference áp dụng khi bridge mới nạp.

Provenance: [checkpoint](../checkpoints/auto-allow-full-access-0.12.49-20261110.json).
Đối chiếu [OpenAI Permissions](https://learn.chatgpt.com/docs/permission-modes)
và [App Server](https://learn.chatgpt.com/docs/app-server); hành vi áp dụng từ
lượt kế tiếp được xác minh bằng runtime đang cài, không suy từ nhãn giao diện.
