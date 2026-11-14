# Tiêu chuẩn UI/UX

Đây là yêu cầu nghiệm thu cho thay đổi giao diện, không phải gợi ý trang trí.

## Bố cục và ngôn ngữ

1. Dùng token màu/font của VS Code; kiểm tra theme sáng, tối và tương phản.
2. Đặt `html/body` margin/padding bằng 0 để không cộng lớp đệm mặc định của webview. Pane chính dùng lề gọn, không lồng nhiều card/padding cho cùng một nội dung.
3. Màn hình chính ưu tiên dữ liệu và thao tác. Chi tiết kỹ thuật, giải thích dài và cấu hình vào dialog/disclosure có chủ đích.
4. Tài khoản gọi là **tài khoản/account**; không dùng “nick”. Phân biệt tài khoản đã xác minh với metadata Chrome BAT.
5. Icon thao tác phải có tooltip và accessible name, hit target nhất quán 26–28 px. Không dùng icon chỉ dựa vào ký tự phông có thể hiển thị khác.
6. Nhóm thao tác Usage canh phải; số liệu bên trái. Tùy chọn/chuyển chat nằm ở đầu tên chat. Mỗi hàng có chuyển chat đúng thread; không còn nút chuyển chung cạnh Chat mới.
7. Hàng công cụ danh sách là ＋ — Lọc chat — Làm mới — Cài đặt, không thêm tiêu đề chiếm một dòng. Nút × của ô lọc nằm trong ô và chỉ hiện khi có nội dung.
8. Composer hẹp giữ hai nút mỗi dòng: Steer — Gửi sau, Dừng — Pause goal. Cột Pause goal đủ rộng cho toàn bộ chữ; không ellipsis hoặc đẩy mỗi nút thành một dòng.
9. Mọi button/input phải kế thừa `media/ui_base.css`, kể cả OK và ? được tạo động. Không để nút rơi về màu/style mặc định của trình duyệt.

## Dialog và draft

- Dialog nằm ngoài vùng dựng lại `#main`, dùng `showModal`, tiêu đề rõ, X/Đóng và Escape.
- Không dựng lại input/tab/row đang tương tác do timer hoặc snapshot nền. Giữ focus, selection, IME, scroll và dropdown được chọn.
- Giữ draft khi đóng/mở trong cùng webview và khi lưu thất bại. Ghi rõ giới hạn nếu draft không tồn tại qua reload.
- Save chờ ACK đúng request ID. Không xóa draft chỉ vì đã gửi command. ACK cũ không được ghi đè chỉnh sửa mới.
- Ngăn double submit ngay tại UI và tại backend. Trạng thái busy không được kẹt vô hạn mà không có kết luận.
- Enter trong input không vô tình gửi hành động; shortcut submit phải rõ. Tab và Shift+Tab không thoát modal.
- Nút ? giải thích thứ tự và hậu quả; mở hướng dẫn không được phát sinh đăng nhập/gửi/chuyển. Escape đóng hướng dẫn trước nếu đang mở.

## Scroll và trạng thái

- Scrollbar phủ lên nội dung, mặc định ẩn, hiện khi tương tác. Không dành một cột cố định hoặc làm thay đổi chiều rộng khi hiện.
- Wheel/touch/keyboard tiếp tục hoạt động; thumb kéo được và có thuộc tính truy cập.
- Header/footer dialog luôn với tới được ở 320×480 và cửa sổ thấp. Chỉ phần nội dung cuộn.
- Online và giữ máy thức có nhịp opacity 10–100%; với reduced motion dùng trạng thái tĩnh. Luôn có nhãn ngoài thông tin màu.
- Khi tất cả âm thanh tắt, icon bị gạch và xám; cập nhật ngay cả trước ACK và hoàn tác khi lưu lỗi.

## Ảnh và dữ liệu trống

- Paste/chọn tệp ảnh có preview, tên, bỏ từng ảnh, lỗi định dạng/kích thước và giữ draft.
- Dấu × xóa ảnh nằm trong góc thumbnail, chỉ hiện khi hover hoặc focus bàn phím.
- Ảnh lỗi không chỉ hiện ô trống: phân biệt nguồn không tồn tại, không được phép đọc, nội dung thiếu và decode thất bại.
- Không dùng dữ liệu giả trong sản phẩm để che lỗi hoặc tạo danh sách tài khoản “đẹp”.
- Loading, empty, error, stale và ready phải phân biệt. Lỗi không chứa raw token, JSON riêng tư hoặc stack dài.

## Bắt buộc kiểm chứng

Chạy UI với trạng thái nền đổi liên tục, focus ở input, form bẩn, lỗi lưu, bấm đôi, đóng/mở và đổi tab. Kiểm tra 320/520/1000 px, cửa sổ thấp và theme sáng/tối; đo overflow, thứ tự DOM, click/keyboard thật. Xem ảnh chụp thật ít nhất cho bố cục thay đổi.

Unit xanh không đủ để báo luồng cài đặt thật đạt. Khi sửa nguồn dữ liệu, kiểm tra module bản cài với nguồn dữ liệu thật trong phạm vi được giao và ghi rõ điều chưa kiểm chứng.
