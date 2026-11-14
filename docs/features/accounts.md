# Quản lý tài khoản

## Trình tự sử dụng

Mở biểu tượng hai người trong vùng Tài khoản. Nút **?** ở đầu dialog giải thích các bước và tác động.

1. Chọn Chrome BAT đã có. **Chọn tệp BAT…** chỉ thêm một launcher chưa có trong danh sách; không đăng nhập hoặc chuyển tài khoản.
2. Chọn **Liên kết phiên hiện tại** hoặc **Mở đăng nhập**.
3. Tài khoản đã liên kết xuất hiện ở danh sách trên. Bấm biểu tượng làm mới của hàng để đọc quota.
4. Chỉ bấm mũi tên chuyển khi muốn đổi phiên Codex đang dùng.

### Liên kết phiên hiện tại

Core đọc phiên Codex hiện tại trong ngữ cảnh cô lập, mở đúng hồ sơ Chrome, xác minh tài khoản và workspace trùng nhau, rồi lưu bản phiên được Windows bảo vệ. Liên kết không đổi phiên đang làm việc.

### Đăng nhập tài khoản khác

Core mở đăng nhập Codex trong BAT đã chọn, giữ phiên đang làm việc. Hoàn tất đăng nhập trên Chrome rồi bấm **Kiểm tra đăng nhập**. Chỉ thành công sau khi Core xác minh và lưu liên kết.

Hủy cửa sổ chọn tệp không thêm BAT. Tệp vừa import được chọn sẵn khi ACK về. Metadata BAT chưa xác minh luôn có trạng thái **Chưa liên kết**.

## Quota và tự động hóa

- Chỉ tài khoản hiện tại được kiểm tra định kỳ. Tài khoản khác kiểm tra theo sự kiện/reset.
- Tự kích hoạt 5h bật riêng từng tài khoản. Quota còn dưới 100% không gửi phép toán.
- Tự kích hoạt tạo Work chat mới, chọn model/reasoning nhẹ nhất được hỗ trợ, gửi một phép cộng và đối soát receipt. Không gửi lại vì quota cập nhật chậm.
- Tự chuyển, tự resume và tự đổi model mặc định tắt.
- Chính sách cho biết xử lý chat đang chạy: chờ, hỏi trước khi dừng, hoặc dừng rồi chuyển.
- Chuyển phiên ảnh hưởng các cửa sổ dùng chung Codex home; chỉ resume sau khi xác nhận tài khoản đích và kiểm tra trạng thái chat.

## Lưu và lỗi

Chỉnh chính sách là bản nháp. Chỉ đánh dấu đã lưu sau ACK của backend; lỗi giữ bản nháp, chỉnh sửa trong lúc lưu không bị ACK cũ ghi đè.

File trạng thái hỏng không làm mất registry BAT/Core. Sau phục hồi, tự động hóa tạm dừng và giao diện giải thích cách tiếp tục. Không báo raw JSON hoặc dữ liệu phiên lên UI.

## Mã và kiểm chứng

- [Controller](../../src/codex_account_manager.js), [lưu trạng thái](../../src/codex_state_store.js).
- [Chuyển account](../../src/codex_account_switcher.js), [lịch Work](../../src/codex_account_scheduler.js), [chính sách](../../src/codex_account_policy.js).
- [Dialog](../../media/account_manager.html), [UI controller](../../media/account_manager.js).
- Unit: `codex_account_*.test.js`, `codex_state_store.test.js`.
- Edge: `test/ui/account_manager_ui.py`.
- Kiểm tra bản cài/dữ liệu thật có chủ đích: `test/integration/account_live_ui.py`; không thực hiện login, chuyển tài khoản hoặc gửi Work.
