# Điều tra lỗi ngắt stream ngày 14/11/2026

Chat được yêu cầu: `01a1d5cb-5445-7640-b257-7b5f394895f8`.
Chỉ dùng bản ghi lỗi, thời gian, trạng thái truyền tải và cấu hình kết nối.
Không trích xuất nội dung hội thoại, lời nhắn, kết quả công cụ, thông tin tài khoản
hoặc credential. Không phát lại request, gửi tin tiếp tục, compact hay restart proxy.
Mọi giờ bên dưới dùng Asia/Saigon (UTC+7).

## Kết luận và độ chắc chắn

Bằng chứng mạnh nhất là lỗi **vượt cửa sổ context**, được phía client biểu hiện
thành `stream disconnected before completion: stream closed before response.completed`.
Chưa có bằng chứng máy mất Internet tại thời điểm xảy ra lỗi.

- Bản ghi lỗi của chat: `task_complete` lúc **02:28:59.704**, mã `other`.
- Log kỹ thuật của Codex có đủ 5 lần retry từ 02:27:16 đến 02:28:38, cùng turn ID.
  Mỗi lần đi kèm `ReasoningSummaryDelta without active item`; lần cuối dừng lúc
  02:28:59. Đây là thông báo giao thức, không phải nội dung reasoning.
- Metadata lỗi trong CH-Relay có 6 request liên tiếp, ID 4627–4632, cùng một
  session key không rỗng. Cả 6 đều chứa thông báo:
  `Your input exceeds the context window of this model. Please adjust your input and try again.`
- Mỗi request ghi HTTP 200 nhưng `ended_in = none`. HTTP 200 không xác nhận
  một stream đã hoàn tất thành công.
- Thời điểm kết thúc 6 request khớp cả 5 retry và lỗi cuối ở Codex trong 10–26 ms.
  Session key của relay không chứa trực tiếp UUID chat; liên hệ được xác lập bằng
  chuỗi thời gian tương ứng, chưa phải phép nối bằng request ID xuyên suốt.
  Chưa có capture giao thức để quy lỗi mất/đổi event chính xác cho relay hay client.

| Request relay | Kết thúc request | Codex ghi nhận sau đó |
| --- | --- | --- |
| 4627 | 02:27:16.712 | 10.371 ms |
| 4628 | 02:27:35.772 | 16.794 ms |
| 4629 | 02:27:57.530 | 15.459 ms |
| 4630 | 02:28:16.434 | 12.016 ms |
| 4631 | 02:28:38.669 | 19.129 ms |
| 4632 | 02:28:59.678 | 26.000 ms |

Nguồn địa phương: dòng lỗi 908 của rollout đã chỉ định; Codex.log trong
`Code/logs/20261113T032625/window1/exthost/openai.chatgpt/`, các dòng
10022–10030; bảng `usage` trong `.ch-relay/ch-relay.sqlite` chỉ đọc các cột
thời gian/trạng thái/lỗi và kiểm tra session key cùng nhau, không xuất session key.

## Kiểm tra kết nối trên chính máy

Kiểm tra trực tiếp lúc **09:51:34–09:51:46**, ba lượt, bốn hostname mỗi lượt:

- `chatgpt.com`: DNS + TLS 1.3 + HTTP 200, 3/3 lượt.
- `www.microsoft.com`: DNS + TLS 1.3 + HTTP 200, 3/3 lượt.
- `www.cloudflare.com`: DNS + TLS 1.3 + HTTP 200, 3/3 lượt.
- `api.openai.com`: DNS + TLS 1.3 + HTTP 421 khi HEAD `/`, 3/3 lượt.
  Kiểm tra tiếp GET `/v1/models` trả **401** như một request không credential;
  đã đến tầng HTTP của dịch vụ, không phải lỗi DNS/TCP/TLS.
- GET `chatgpt.com/backend-api/codex/models` không credential cũng trả 401.
  Các phép thử này không chứng minh một request sinh nội dung/stream sẽ thành công.
- Wi-Fi đang Up, có default route và DNS. Windows NetworkProfile,
  WLAN-AutoConfig và NCSI đều bật, nhưng không có sự kiện trong 02:10–02:45;
  kiểm tra rộng 01:00–04:00 cũng không có sự kiện của ba log này.
- System không ghi lỗi/cảnh báo trong 02:10–02:45. Không có sự kiện sleep/resume
  trong 01:00–04:00; có sự kiện đổi nguồn điện lúc 01:08:40, ID 105.

Kết quả hiện tại không chứng minh tuyệt đối tình trạng WAN lúc 02:28. Nhật ký
Windows cũng không phát hiện được mọi gián đoạn WAN ngắn. Tuy nhiên, cả chuỗi
request lúc lỗi đã nhận lỗi context có cấu trúc từ phía dịch vụ/relay.

## Đường đi và chỗ còn thiếu trong Tracker

- Cấu hình Codex: `openai_base_url = http://127.0.0.1:11500/v1`.
  Port 11500 hiện do `agent.exe` giữ; Tracker lưu đường dẫn CH-Relay agent.
- Proxy hiện trả HTTP: `/v1/models` không credential trả 401; `/health` trả 404.
  404 chỉ cho biết đường dẫn health này không được hỗ trợ, không được dùng làm
  kết luận proxy chết. Tiến trình có kết nối HTTPS ra ngoài.
- Watchdog bật ở ngưỡng 10 phút; bản ghi restart gần nhất là 05:12:12 ngày 13/11,
  không trùng thời điểm lỗi. Tiến trình proxy đang chạy có thời điểm khởi động
  20:30:51 ngày 12/11. Bản ghi restart không phải bằng chứng tiến trình đã được
  thay thế thành công.
- `codex_error_alerts.js` hiện phân loại 429 hết retry và model capacity, chưa có
  nhánh riêng cho stream EOF/context. `proxy_watchdog.js` theo dõi task running
  bị im lâu; `proxy_recovery.js` chỉ tiếp tục các task đã lưu trước restart.
  Chat đã kết thúc với lỗi này không tự được các nhánh đó xử lý.
- Gateway trace của Tracker không có record trong 02:20–02:35; không dùng việc
  thiếu capture làm bằng chứng upstream không hoạt động.
- Config toàn máy đang đặt context **900000**, auto-compact **780000**. Cần đối
  chiếu giới hạn thật của route/model và các override riêng của chat trước khi
  điều chỉnh; số cấu hình không làm tăng giới hạn của upstream. Chưa kết luận
  hai con số này là cấu hình hiệu lực của lượt bị lỗi.

## Các kịch bản xử lý đề xuất

Đây là thiết kế đề xuất; chưa bật cơ chế tự khôi phục hoặc sửa cấu hình đang dùng.

| Tình huống | Bằng chứng cần dùng | Xử lý |
| --- | --- | --- |
| Vượt context như chuỗi đang điều tra | Mã/thông báo context trong lỗi native hoặc relay đã đối chiếu | Dừng retry cùng request; hiện lỗi đúng; dùng compact nếu runtime hỗ trợ chat đã dừng, nếu không mở luồng chuyển chat sẵn có. Nếu compact cũng báo context, dừng vòng lặp và chuyển phương án. |
| Mất Internet thật | Nhiều đích độc lập cùng lỗi DNS/TCP/TLS; trạng thái adapter/route hỗ trợ kết luận | Giữ trạng thái chờ mạng, không reset proxy; thử kết nối theo backoff, yêu cầu hai lượt thành công trước khi xét tiếp tục. |
| Lỗi DNS | Lookup thất bại trong khi một phép thử kết nối có kiểm soát vẫn đi được | Báo lỗi DNS; kiểm tra resolver/cấu hình hiện có. Không tự đổi DNS toàn máy hoặc tắt TLS. |
| Chỉ tuyến OpenAI/upstream hỏng | Các đích độc lập tốt, đúng upstream/route thất bại | Phân loại lỗi tuyến dịch vụ; thử lại có giới hạn, kiểm tra proxy/VPN/firewall và upstream. Không báo máy mất Internet toàn bộ. |
| Proxy cục bộ chết hoặc treo | TCP local từ chối hoặc request đơn giản liên tục timeout, Internet độc lập tốt | Xác nhận đúng process/port; chỉ restart trong chính sách đã được cho phép, sau khi xét các chat khác đang chạy; kiểm tra listener và phản hồi sau restart. |
| Codex đang tự retry | `willRetry=true` hoặc turn còn active | Hiện trạng thái đang kết nối lại; không tạo lượt mới song song với retry native. |
| HTTP 429/502/503 hoặc capacity | HTTP và lỗi stream có cấu trúc | Tôn trọng Retry-After khi có, backoff giới hạn; quota/capacity phải có nhãn riêng. Không dùng reset mạng để xử lý quota. |
| Hết phiên/không được phép | Lỗi xác thực 401/403 từ request thật có xác thực; phân biệt với probe không credential | Yêu cầu đăng nhập/quyền tương ứng; không lặp request vô hạn hoặc coi probe 401 là phiên người dùng hỏng. |
| EOF/mất event cuối, chưa biết nguyên nhân | Mạng/proxy sống nhưng thiếu terminal event, có thể có event sai thứ tự | Giữ trạng thái chưa hoàn tất; thu request ID, HTTP status, tên event, byte count và thời gian. Không giả tạo `response.completed`; sửa tầng chuyển tiếp/giải mã sau khi xác định. |
| Mất ACK hoặc client ngắt nhưng backend còn chạy | Kiểm tra trạng thái native theo thread/turn trước khi gửi lại | Nếu đang chạy thì theo dõi; nếu đã hoàn thành thì kết thúc; nếu chưa biết có nhận lệnh tiếp tục không thì không gửi trùng. |

Ưu tiên triển khai:

1. Nhận diện lỗi terminal và giữ nguyên lỗi gốc từ relay. Với tương quan chỉ bằng
   thời gian, hiển thị là nghi vấn có độ tin cậy cao, không tự sửa/compact một chat
   khi chưa xác nhận được thread/turn tương ứng.
2. Chẩn đoán theo ba tầng: Internet độc lập → đúng upstream → proxy local.
   Chỉ chạy khi có lỗi hoặc người dùng yêu cầu; probe ngắn, có timeout, không
   credential và không gửi nội dung chat. Kết quả ghi rõ thời điểm đo.
3. Trước mọi khôi phục, kiểm tra trạng thái turn bằng đường chỉ đọc hiện có.
   Loại trừ turn đã hoàn thành, người dùng tự dừng, chat đang chuyển tiếp,
   đang chờ duyệt và trạng thái gửi chưa xác nhận.
4. Khóa theo `(threadId, turnId, lỗi)`, lưu attempt/nextAttemptAt/ACK và áp dụng
   cooldown. Ví dụ policy đề xuất 5/15/45 giây, tối đa 3 lần sau retry native;
   bật tự tiếp tục riêng, không mặc định áp dụng cho lỗi context/auth/quota.
5. Kiểm thử offline, DNS lỗi, proxy trả 401/404, EOF thiếu terminal, lỗi context
   nằm trong stream HTTP 200, retry native đang chạy, đổi turn và ACK bị mất.

## Đối chiếu tài liệu chính thức

- Codex có lỗi `contextWindowExceeded`; thông báo `willRetry=true` giữ lượt
  đang active. [Codex App Server](https://learn.chatgpt.com/docs/app-server).
- Gateway phải giữ cả event thành công và event lỗi, không suy ra thành công
  chỉ từ text/HTTP 200; model catalog phải phản ánh giới hạn upstream thực.
  [Gateway compatibility](https://learn.chatgpt.com/docs/enterprise/gateway-compatibility).
- Cấu hình có giới hạn retry stream và timeout riêng; tăng retry không sửa lỗi
  input quá dài. [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
