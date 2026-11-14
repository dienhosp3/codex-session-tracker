# Đóng gói và cài local

Packager chuẩn là [scripts/package.ps1](../../scripts/package.ps1). Manifest `package.json.files` là nguồn liệt kê payload duy nhất; không giữ một script Bash chép file riêng dễ lệch.

1. Chạy test phù hợp; thay đổi đường dẫn/module phải chạy toàn bộ unit và kiểm tra webview.
2. Tạo checkpoint bằng extension Codex thực sự đang cài, không chép phiên bản cũ.
3. Đóng gói vào `dist`. Runtime phải khớp SHA256 của `runtime/manifest.json`.
4. Cài local bằng VS Code CLI; đối chiếu payload đã cài với VSIX và metadata phiên bản đăng ký.
5. Người dùng reload cửa sổ để nạp mã mới; không tự reload chat đang chạy.

```powershell
node scripts/checkpoint.js --extension-root "<Codex extension directory>" --label "<release>" --output "artifacts/checkpoints/<release>.json"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package.ps1 -RuntimeSource "<Tracker directory with matching runtime>"
code --install-extension "dist/codex-session-tracker-<version>.vsix" --force
```

RuntimeSource có thể là bản Tracker đã cài khi binary trong repo đã được dọn. Không lấy CLI bất kỳ chỉ vì cùng tên.

Runtime custom có nguồn/hook/manifest/giấy phép tại `runtime`. Rebuild là thao tác riêng, tốn tài nguyên và cần kiểm tra compatibility; không rebuild chỉ để chỉnh CSS.

Giữ VSIX hiện tại cần bàn giao, checkpoint và kết luận. Không chất các bản trung gian ở gốc repo. Không tự commit, push, publish hoặc deploy.
