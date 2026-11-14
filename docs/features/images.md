# Ảnh trong chat và đính kèm

Phải phân biệt ảnh người dùng đính kèm, ảnh assistant/tool trả về và đường dẫn file chỉ được nhắc trong văn bản. Deeplink chuyển tiếp không tự sao chép byte của mọi ảnh trong lịch sử.

## Dán, đính kèm và gửi sau

Composer, tạo chat và chuyển tiếp đều hỗ trợ paste/chọn PNG, JPEG, WebP, GIF (tối đa 8 MiB mỗi ảnh). Preview giữ cùng bản nháp; dấu × nằm trong góc ảnh, chỉ hiện khi hover hoặc focus bàn phím. Tạo chat nhận cả yêu cầu chỉ có ảnh. Chuyển tiếp truyền ảnh đã chọn ở cả Thường/Plan/Goal.

CLI đang kiểm chứng có liệt kê `queue --image` trong help nhưng từ chối ảnh lúc thực thi. Vì vậy **Gửi sau có ảnh** dùng `codex_image_queue`: ghi ảnh bền vững vào `attachments` theo SHA256, lưu hàng chờ trước khi ACK, chờ đúng lượt nguồn hoàn tất rồi gửi qua native owner. Tối đa 20 tin ảnh đang chờ; hàng chờ của từng chat giữ thứ tự.

Không gửi khi chat còn chạy, chờ người dùng hoặc goal đang pause. Mất xác nhận lần gửi trước phải kiểm tra chat, không tự gửi lại. Hàng chờ tồn tại qua reload; có thể hủy tin còn chờ hoặc đã lỗi. Ảnh và receipt không bị dọn cùng log.

## Vòng đời ảnh xem trong lịch sử

ImageView có thể lưu đường dẫn nguồn để tải thumbnail về sau. Xóa file sau khi xem sẽ làm ảnh từng hiện được trở thành Failed; deeplink/chuyển chat không khôi phục file đó.

Trước khi xem screenshot nháp, chạy [retain-preview.ps1](../../scripts/retain-preview.ps1), rồi dùng đường dẫn trả về trong `retained-images`. Helper kiểm tra hash và quyền tài khoản Windows thường. Chỉ dọn bản nháp sau khi ảnh đã được giữ bền vững. File còn tồn tại nhưng không đọc được cần kiểm tra ACL riêng; không coi mọi ảnh Failed là cùng một nguyên nhân.

## Điều kiện kiểm chứng

- Kiểm tra đúng event chứa ảnh và dữ liệu transport, không chỉ thấy placeholder “Viewed images”.
- So sánh ảnh còn đọc được với ảnh Failed trong cùng phiên: loại nguồn, URI/path, payload, quyền đọc và vòng đời file.
- Nếu dùng file nháp để render ảnh, không được khẳng định người dùng xem lại được sau khi file nguồn đã bị dọn.
- Không ghi token, signed URL hoặc base64 ảnh riêng tư vào report.
- Form tạo/chuyển chat phải kiểm tra loại/kích thước ảnh, cho xem trước và bỏ ảnh, giữ draft qua cập nhật nền, chống gửi trùng cả text lẫn ảnh.

## Điểm mã cần xem

- [Đọc ảnh từ rollout](../../src/tracker.js).
- [Đầu vào native](../../src/codex_live_backend.js), [steer/continue](../../src/codex_steer.js).
- [Kho ảnh](../../src/codex_image_store.js), [hàng chờ bền vững](../../src/codex_image_queue.js), [UI dùng chung](../../media/image_attachments.js).
- [Tạo chat](../../src/codex_new_chat.js), [chuyển tiếp](../../src/codex_context_handoff.js).
- [Dashboard/composer](../../media/dashboard.html), [tạo mới](../../media/new_chat_dialog.js), [chuyển tiếp](../../media/handoff_dialog.js).

Kết luận một lỗi ảnh cụ thể phải ghi bằng chứng trong verification; không quy lỗi cho Codex hoặc Tracker từ ảnh placeholder đơn lẻ.

Kiểm chứng: [native loopback](../../test/integration/image_inputs_smoke.js), [queue](../../test/unit/codex_image_queue.test.js), [UI paste/preview](../../test/ui/image_attachments_ui.py). Native loopback dùng binary Codex đang cài với home cô lập; không gửi model ngoài máy.
