# Chat và điều hướng

## Danh sách và vùng chi tiết

Tab Đang chạy/Không chạy dùng trạng thái task thật. Hàng đang chọn trong Tracker và chat thực sự đang mở trong Codex là hai trạng thái riêng.

Mỗi hàng có vòng context, tùy chọn và nút chuyển tiếp. Nút chuyển trên hàng phải dùng thread của chính hàng đó, không dùng thread đang chọn. Các nút con không được kích hoạt chọn hàng.

Trong phần đầu chat, hai icon tùy chọn/chuyển tiếp nằm trên tên. Nút chuyển cạnh Chat mới đã được loại bỏ.

Hàng công cụ danh sách theo thứ tự **＋ — Lọc chat — Làm mới — Cài đặt**, không có dòng tiêu đề riêng. Dấu ＋ là icon lớn; nút × nằm trong ô lọc và chỉ hiện khi có nội dung.

## Tạo và gửi

**Chat mới** mở form workspace, model, tốc độ, context và yêu cầu. Lựa chọn context không được giả định có sẵn cho mọi model. Các quyền và chế độ phải đi qua contract native đã hỗ trợ.

**Steer** gửi vào lượt đang chạy qua owner hiện có. **Gửi sau** dùng queue CLI cho văn bản; khi có ảnh, dùng hàng chờ bền vững của Tracker rồi gửi qua native owner khi lượt nguồn hoàn tất. **Tiếp tục chat** tạo lượt mới trong thread cũ. **Dừng/Pause goal** không phải xóa chat. Ở giao diện hẹp, giữ hai dòng **Steer — Gửi sau** và **Dừng — Pause goal**, luôn hiện đủ tên nút.

Form không tự submit khi đang gõ; chống bấm đôi, giữ bản nháp khi lỗi. Xem [ảnh đính kèm](images.md).

## Nhãn, ID, xóa

Nhãn hiển thị riêng không tự đổi tên gốc. Mã ID nhận 1–30 chữ/số Unicode, dấu cách và `_`; STT là số nguyên dương, giữ ít nhất bốn chữ số. Đổi mã ID trong Tùy chọn chat áp dụng cho cả họ có quan hệ chuyển tiếp, giữ STT của các chat còn lại. Đổi STT hiện tại không được trùng một thành viên khác.

Họ chat được xác định bằng liên kết nguồn/kế tiếp và family ID, không suy từ nhãn giống nhau. Nhãn của thành viên có ID hiển thị **[STT] Nhãn**; các họ khác cùng nhãn giữ mã và STT riêng. Việc đổi metadata không gửi model, không dừng hoặc resume chat; lỗi giữa chừng sẽ thử hoàn tác các tên đã đổi và báo lỗi nếu không hoàn tác hết. Mã nhận diện cuộc chat với agent không được chép vào source hoặc fixture.

Xóa chat phải kiểm tra lại trạng thái sau xác nhận; dữ liệu danh sách có thể đã cũ. Hủy xác nhận không đổi tab đang chọn.

## Mã và kiểm chứng

- [Reader](../../src/tracker.js), [worker](../../src/session_reader.js).
- [Điều hướng](../../src/codex_navigation.js), [chat hiện tại](../../src/codex_current_chat.js).
- [Gửi](../../src/codex_steer.js), [queue](../../src/codex_queue.js), [tạo mới](../../src/codex_new_chat.js).
- [Form tạo chat](../../media/new_chat_dialog.js), [tùy chọn](../../media/chat_options.js).
- Unit: tracker, navigation/current-chat, new-chat, auth/delete, continue/steer.
- Edge: new_chat_dialog, chat_feedback, layout_controls, scrollbars.
