# Codex Session Tracker 0.13.0 / ChatGPT Core 0.4.0

Đã cài Tracker và kích hoạt core mới. Core đang chạy trả đúng 0.4.0 và đủ capability account/quota/Work. Ba launcher cũ và ledger nghiệp vụ được giữ nguyên; không đổi account thật của người dùng, không truy cập kho hoặc cấu hình proxy.

## Kiểm chứng

- 524 kiểm thử Tracker đạt; 423 kiểm thử core đạt, thêm 39 kiểm thử tập trung sau các cập nhật liên quan; kiểm tra cú pháp và tính toàn vẹn vendor đạt.
- Edge: 1.000 chat, cập nhật quota không thay thế các hàng chat; OK/X, cài đặt account, hủy countdown và xử lý lỗi đạt ở nhiều kích thước.
- Native Plan OK gọi đúng lựa chọn implement-plan và chống bấm đôi; X chỉ ẩn bảng chờ, không tắt âm thanh.
- Chrome2: một phép toán được gửi trong Work và chờ được phản hồi hoàn tất. Lần gửi ban đầu dùng GPT-6 Luna; sau chỉnh sửa của người dùng, xác minh riêng bộ chọn GPT-5.6 Luna / Light, slider ở mức thấp nhất, Fast Mode tắt và không gửi thêm tin.
- Codex app-server thật chạy trong home cô lập, không lấy phiên đang dùng. Đã sửa chờ tiến trình close và dọn thư mục tạm sau EBUSY; các lượt kiểm tra tiếp theo dọn sạch.
- Kiểm chứng thêm 29 thư mục nháp và ACL tệp con bằng token thường của LEGION\\SP3: kế thừa và FullControl đạt; probe tạo/đọc/sửa/đổi tên/xóa đạt; đã dọn hết.
- Đổi account/rollback/resume và các trường hợp mất ACK được kiểm thử bằng fixture cô lập; chưa thực hiện chuyển account thật hay OAuth mới trên phiên làm việc của người dùng.

## Tệp cài đặt

- VSIX: 325 entry, gồm 323 tệp payload. 322 tệp cài đặt trùng bytes; package.json tương đương sau bỏ metadata VS Code thêm. Không có sai lệch.
- Core: đối chiếu 4.176 tệp theo inventory, không sai lệch. Runtime cũ được thay tại điểm không có request gửi đang chờ hoặc turn chưa dừng.
- Checkpoint ghi đúng OpenAI Extension 26.51021.22027 và CLI bundled 0.164.0-alpha.11.1; rollout metadata không được thu thập.

## Sử dụng

Reload các cửa sổ VS Code để nạp Tracker mới. Trong **Quản lý account**, chọn BAT và liên kết nick Codex hiện tại, hoặc dùng đăng nhập qua BAT cho nick khác. Kho account mới chưa được tự điền từ nguồn ngoài; mỗi nick cần liên kết lần đầu.

Tự kích hoạt, tự chuyển, tự resume và tự đổi model mặc định tắt. Bật riêng theo nhu cầu. Quota 5h còn dưới 100% không gửi phép toán. Chỉ nick hiện tại có kiểm tra định kỳ; nick phụ dùng lịch theo sự kiện/reset.

Quét lại cùng tập 26 chat không chạy giảm từ khoảng 332 ms xuống 20–21 ms sau cache. Không dùng phép đo này để khẳng định thời gian render nội dung bên Codex; phần đó phụ thuộc native extension và được tách khỏi đường chọn chat của Tracker.
