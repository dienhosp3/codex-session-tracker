# Chẩn đoán nhanh

## Account dialog báo JSON invalid

1. Xác định file gây parse lỗi; không dump nội dung kho phiên vào log.
2. Kiểm tra kích thước, encoding/BOM và byte NUL.
3. State store giữ một backup hợp lệ; account recovery giữ byte gốc ở .corrupt và phục hồi dưới cùng khóa.
4. Sau phục hồi, tự động hóa dừng; kiểm tra/lưu chính sách trước khi tiếp tục.
5. Kiểm chứng refresh qua module bản cài, file app thật và Core thật. Fixture UI không đủ cho lỗi này.

Đã từng có file account state 716 byte toàn NUL. Không coi “không có tài khoản liên kết” là nguyên nhân parse lỗi; registry BAT và state file là hai nguồn khác nhau.

## Usage chưa có số khi mới mở VS Code

Codex có thể khởi động sau Tracker. Trước khi account/quota sẵn sàng, dấu `---` là trạng thái chờ. Chỉ chẩn đoán lỗi thật sau readiness; không tạo popup/âm báo giả.

## Chọn chat chậm hoặc hiện sai chat

Tách thời gian phản hồi hàng, gửi điều hướng và Codex xác nhận route. Kiểm tra cache metadata/reader worker và quyền ưu tiên yêu cầu mới nhất. Không dùng quét rollout đồng bộ trên đường click.

## Form tự đóng, mất chữ hoặc nhảy cuộn

Kiểm tra node có bị thay bởi `main.innerHTML` không. Dialog/input phải sống ổn định ngoài vùng đó. Chạy snapshot liên tục trong khi gõ và mở dropdown; chỉ kiểm tra một lần mở dialog là chưa đủ.

## Traffic trống

Phân biệt Gateway đang chạy với traffic thật đã quan sát. Kiểm tra capture mode, tuyến proxy/hook và compatibility runtime. CONNECT mã hóa không cho plaintext body. Tắt Gateway không xóa log cũ.

## Ảnh Failed

Xem [quy trình ảnh](../features/images.md). Kiểm tra đúng payload và file/URI còn sống tại lúc UI tải, kể cả sau reload/chuyển chat. Không kết luận từ việc model đã “nhìn thấy” ảnh trong tool output.

## Sau nâng cấp vẫn thấy nút cũ

Xác minh phiên bản đăng ký trong VS Code và payload đã cài; reload cửa sổ khi người dùng sẵn sàng. Không trộn source mới với webview cũ rồi báo đã kiểm chứng giao diện mới.
