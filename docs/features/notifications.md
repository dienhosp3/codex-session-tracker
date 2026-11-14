# Thông báo, âm thanh và giữ máy thức

## Trạng thái chờ

Approval, câu hỏi async và quyết định triển khai kế hoạch là các yêu cầu khác nhau. **OK** của Plan gọi hành vi native chấp nhận kế hoạch, không gửi chữ OK như chat thường.

**X** trong bảng chờ chỉ ẩn đúng thông báo; không trả lời, từ chối approval, hủy tác vụ hoặc tắt âm thanh. Yêu cầu mới của cùng thread vẫn hiện.

## Âm thanh

Controller phân biệt âm chờ duyệt, chờ trả lời, hoàn tất, lỗi và quota. Công tắc chung, công tắc loại âm và tùy chọn hoàn tất riêng từng chat cùng tham gia quyết định phát.

Giọng tiếng Việt đã duyệt nằm trong `media/attention_voice` và `media/usage_voice`; runtime phát offline. Không dùng bản sao trong thư mục sample làm nguồn sản phẩm.

Khi toàn bộ âm bị tắt, icon âm thanh phải thể hiện rõ trạng thái tắt bằng màu xám và gạch ngang, kèm aria-label/title tương ứng.

## Giữ máy thức

Đây là trạng thái độc lập với Gateway online. Icon thể hiện bật/tắt và lỗi, không đánh đồng với việc chat đang chạy. Animation trạng thái dùng opacity 10–100% và tôn trọng reduced motion.

## Mã và kiểm chứng

- [Attention](../../src/codex_attention.js), [async input](../../src/codex_async_input.js), [Plan](../../src/codex_plan_state.js).
- [Sound settings](../../src/codex_sound_settings.js), [completion](../../src/codex_completion_sounds.js), [keep awake](../../src/codex_keep_awake.js).
- [Giao diện âm thanh](../../media/sound_settings.js).
- Unit: attention, dismissals, async-input, sound-settings, voice, completion.
- Edge: sounds_layout, plan_prompt, async_input.
