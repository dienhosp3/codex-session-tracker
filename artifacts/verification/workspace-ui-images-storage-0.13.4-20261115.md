# Tracker 0.13.4 — kiểm chứng và bàn giao local

Hoàn tất ngày 15/11/2026 (Asia/Saigon). Đã cài local; cửa sổ VS Code đang chạy cần người dùng Reload Window để nạp mã mới. Không tự reload, commit, push hoặc publish.

## Thay đổi

- Quản lý account bằng modal trong vùng Tài khoản; icon đồng bộ, hướng dẫn liên kết, badge gói và giữ draft/focus/tab khi cập nhật nền.
- Bỏ dòng tiêu đề danh sách, lề ngoài dư và scrollbar chiếm cột. Toolbar: ＋, ô lọc có ×, làm mới, cài đặt. Chuyển chat trên từng hàng.
- Giao tiếp thu gọn; online/giữ máy thức nhịp opacity 10–100%, hỗ trợ reduced motion. Icon âm thanh gạch/xám khi tắt hết. Style chung cho cả OK và ?.
- Composer hẹp giữ Steer — Gửi sau / Dừng — Pause goal; không cắt chữ.
- Paste/chọn ảnh cho tạo chat và chuyển tiếp; × xuất hiện khi hover/focus. Gửi sau có ảnh dùng hàng chờ bền vững, gửi đúng lượt qua native owner.
- Sáu mức context: mặc định model, 400K, 550K, 700K, 900K, tự đặt. Cấu hình 600K cũ giữ nguyên dưới dạng tự đặt.
- ID nhận dấu cách/underscore; đổi mã theo họ chuyển tiếp, giữ STT từng chat, không gộp họ khác chỉ vì cùng nhãn. Nhãn hiển thị kèm STT.
- Dọn trace/log 7 ngày/512 MiB, preview và kết quả thật; ảnh, tài khoản, lịch sử và receipt được bảo vệ. Cache nội dung reader tối đa 64 MiB theo kích thước JSON.
- Source/UI/test được tách thư mục; 19 trang docs theo chức năng và chuẩn UI/UX. Tài liệu storage, ảnh, context và ID đã cập nhật theo hành vi cuối.

## Kiểm chứng trong lượt hoàn thiện

| Phạm vi | Kết quả |
| --- | --- |
| Unit qua scripts/test.ps1 | 555 đạt; 0 lỗi, bỏ qua hoặc hủy |
| Native Codex đang cài, home cô lập, model loopback | 3 đạt: đổi ID họ/hoàn tác không tạo lượt model; ảnh cho tạo mới/Thường/Plan/Goal; queue ảnh gửi một lần sau lượt nguồn |
| Edge headless, workspace_controls_ui.py | Toolbar/lọc, STT, sáu context, tự đặt 650K, giữ 600K cũ, style và chính sách dọn đạt |
| Hồi quy dọn dữ liệu UI | Draft qua poll, chặn dọn khi chưa lưu, chờ ACK đúng ID, bỏ ACK cũ, lỗi giữ draft, lưu lại và làm mới RAM đạt |
| Layout/theme | 320/520/1000 px; dark/light/high contrast; bốn nút không cắt chữ; header/footer dialog tới được ở 320×480 |
| Kiểm tra ảnh giao diện | Đã xem screenshot composer 320 px và dialog dọn trên theme sáng; nguồn đã promote bằng retain-preview.ps1 trước khi view |
| Bản cài + Core/globalStorage thật | Refresh UI 3 lần; 3 BAT, 0 account đã liên kết; không lỗi JSON/JavaScript; hai icon account, hướng dẫn và hai cách liên kết hoạt động |
| Ảnh lịch sử đã khôi phục | 7 đường dẫn tồn tại, đọc/hash được bằng token thường LEGION\SP3; khớp bản bền vững; có FullControl của SID người dùng |
| Storage thật | Chính sách automatic=true, 7 ngày, 512 MiB; khoảng 333,4 MiB trace/log, không có file đủ điều kiện dọn thêm hoặc cảnh báo khi kiểm tra |
| Tài liệu / diff | 19 tài liệu, 124 liên kết nội bộ hợp lệ; git diff --check đạt |
| Gói/cài đặt | VSIX 352 entries; 350 tệp payload cài khớp (bỏ metadata do VS Code thêm trong package.json); registry 0.13.4 |

Các suite UI chức năng còn lại đã đạt trong lượt triển khai trước; kết quả ở bảng là các lần chạy lại khi hoàn thiện. Không phát sinh model request ngoài máy trong integration. Luồng đổi tài khoản/resume thật chưa được nghiệm thu trong lượt này vì dữ liệu hiện có chưa có account liên kết.

## Ảnh Failed và giới hạn kết luận

Lỗi đã xác nhận ở bảy ảnh xem trước: ImageView giữ đường dẫn nguồn nhưng file nháp đã bị dọn; ảnh có thể hiện ban đầu rồi Failed khi tải lại. Lượt trước đã phục hồi byte từ output và khôi phục đường dẫn cũ bằng hard link tới ảnh bền vững. Lượt này kiểm tra lại cả bảy bản và quyền người dùng. Không sửa rollout/database hay khẳng định mọi ảnh Failed có cùng nguyên nhân.

Ba thư mục account-live/account-preview cũ dưới scratch chỉ còn bảy ảnh phục hồi nói trên; được giữ có chủ đích để đường dẫn ImageView cũ còn hoạt động. Chúng là nguồn ảnh lịch sử, không phải profile/log test để xóa. Tất cả scratch mới của lượt này được kiểm tra ACL/token thường, đóng process và dọn trong finally; không còn thư mục chạy mới.

Lịch sử dọn thật lưu trong storage-maintenance xác nhận lượt trước đã xóa 791 file, 333.657.674 byte, không lỗi. Lượt này chỉ kiểm tra lại dữ liệu, không dọn thêm log khi không có ứng viên.

## Artifact và phiên bản

- VSIX: `dist/codex-session-tracker-0.13.4.vsix`.
- SHA256: `51a5b24c55ebb169bf612e7606374f26e538174b3a2fc9bed0e9484fbde94754`.
- [Checkpoint runtime](../checkpoints/workspace-ui-images-storage-0.13.4-20261115.json): Codex extension 26.51021.22027, bundled CLI 0.164.0-alpha.11.1; rollout model gpt-6-astra. Checkout có thay đổi chưa commit.
- Node v24.15.0, Python 3.14.4. Runtime Tracker lấy từ bản cài 0.13.3, được đối chiếu SHA256 với manifest; không rebuild runtime chỉ để sửa UI.
- Packager kiểm tra từng hash source/runtime trong archive. Module/docs hiện hành có trong gói; test, sample và artifacts không được đóng gói.

## Dọn repo còn bị chặn

- `voice-test/`: 131 file, 19.488.208 byte. Lệnh xóa ở lượt triển khai trước bị kiểm duyệt công cụ từ chối: `blocked by policy`.
- `dist/codex-session-tracker-0.13.3.vsix`: 113.375.972 byte. Lệnh xóa đúng file cũ, sau kiểm tra phạm vi/reparse, tiếp tục bị kiểm duyệt công cụ từ chối: `blocked by policy`.

Hai mục trên vẫn còn nguyên. Đây là policy rejection trước khi thực thi, không phải Windows Access Denied hoặc file bị process giữ. Không đổi shell/cách xóa để vượt chặn.

## Cập nhật trước đồng bộ GitHub — 15/11/2026

Khi kiểm tra lại sau yêu cầu dọn và push, cả `voice-test/` lẫn VSIX 0.13.3 đã không còn trên đĩa. Không phát sinh thao tác xóa lại hai mục này. Preview `scripts/cleanup.py` báo 0 đối tượng/0 byte cần dọn; `dist` chỉ giữ gói 0.13.4. Xóa sample được ghi nhận trong Git; các ảnh lịch sử đã khôi phục vẫn được giữ riêng.
