# Bản đồ module

## Ranh giới thư mục

| Vị trí | Trách nhiệm |
| --- | --- |
| [extension.js](../../extension.js) | Điểm vào VS Code: commands, lifecycle, IPC webview, ghép các controller |
| [src](../../src/) | Nghiệp vụ Tracker; CommonJS, không chứa HTML hoặc bản build |
| [media](../../media/) | Dashboard, dialog, controller trình duyệt và tài nguyên âm thanh đã duyệt |
| [gateway](../../gateway/) | HTTP/WebSocket/CONNECT, instrumentation, correlation, lưu/đọc traffic |
| [chatgpt-sdk](../../chatgpt-sdk/) | SDK của AHUST ChatGPT Core; thay đổi có chủ đích theo phiên bản Core |
| [runtime](../../runtime/) | Manifest, nguồn hook và giấy phép runtime; binary sinh ra không phải source |
| [scripts](../../scripts/) | Kiểm thử, scratch, đóng gói, provenance, bảo trì |
| [test](../../test/) | unit, ui, integration, fixtures tách riêng |
| [docs](../README.md) | Hướng dẫn theo chức năng và kiến trúc |
| [artifacts](../../artifacts/) | Checkpoint và kết luận kiểm chứng nhỏ, có mục đích |
| dist | VSIX phát hành local; không commit |

## Tìm mã theo việc cần sửa

| Nhóm | Module chính trong src |
| --- | --- |
| Đọc session | `tracker.js`, `session_reader.js` |
| Mở đúng chat đang chọn | `codex_navigation.js`, `codex_current_chat.js` |
| Native Codex đang chạy | `codex_owner_bridge.js`, `codex_live_backend.js` |
| Gửi/queue/steer | `codex_steer.js`, `codex_queue.js`, `codex_new_chat.js` |
| Ảnh và hàng chờ ảnh | `codex_image_store.js`, `codex_image_queue.js`; UI dùng `media/image_attachments.js` |
| Cache/dọn log | `codex_storage.js`, `tracker.js`, `session_reader.js`; UI dùng `media/storage_manager.js` |
| Tùy chọn/nhãn/quyền chat | `codex_chat_options.js`, `codex_chat_identity.js`, `codex_thread_permissions.js`, `codex_auto_allow.js` |
| Context/chuyển tiếp | `codex_context_reader.js`, `codex_context_watch.js`, `codex_context_handoff.js`, `codex_context_compact.js` |
| Biểu mẫu tạo/chuyển chat | `codex_new_chat_form.js`, `codex_handoff_form.js`, `codex_handoff_modes.js`, `codex_new_chat_context.js` |
| Tài khoản | `codex_account_manager.js`, `codex_accounts_core.js`, `codex_account_policy.js` |
| Lịch/chuyển tài khoản | `codex_account_scheduler.js`, `codex_account_switcher.js`, `codex_account_barrier.js` |
| Usage | `codex_usage.js`, `codex_usage_cycle.js`, `codex_usage_history.js`, `codex_usage_notifications.js` |
| Âm thanh/cảnh báo | `codex_attention*.js`, `codex_usage_voice.js`, `codex_error_sound.js`, `codex_sound_settings.js`, `codex_completion_sounds.js` |
| Câu hỏi/Plan/Goal | `codex_async_input.js`, `codex_plan_state.js`, `codex_compaction_events.js` |
| Phục hồi lỗi | `codex_failures.js`, `codex_failure_recovery.js`, `codex_connection_diagnostics.js` |
| Lưu trạng thái dùng chung | `codex_state_store.js` |
| Đăng nhập/xóa chat | `codex_auth.js`, `codex_delete.js` |
| Công cụ khác | `codex_keep_awake.js`, `codex_speed.js`, `runtime_versions.js` |
| Điều phối proxy đã cấu hình | `local_proxy.js`, `proxy_watchdog.js`, `proxy_recovery.js` |

Không đưa controller mới vào `extension.js` nếu nó có thể kiểm thử độc lập. Điểm vào chỉ nối dependency và chuyển thông điệp. Không thêm file thử, ảnh chụp, log hoặc bản sao thư viện ở gốc repo.
