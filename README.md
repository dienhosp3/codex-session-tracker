# Codex Session Tracker 0.12.51

## ID hiện tại, nhãn riêng và Goal đơn giản

- **⚙ Tuỳ chọn chat** có **ID chat hiện tại**, **Số hiện tại** và **Nhãn hiển thị**.
  Lưu ID đổi mã ở tên gốc ngay, giữ phần tên phía sau; không cần chuyển chat,
  không ngắt lượt đang chạy. Ví dụ đặt `dựÁn / 25` tạo `[dựÁn-0025] Tên gốc`,
  chat tiếp theo là `[dựÁn-0026] Tiếp tục`. Giữ 1–30 chữ/số Unicode và padding.
- Nhãn chỉ thay chữ hiển thị trong Tracker, không đổi tên native hay UUID,
  không dùng làm ID hoặc đưa vào prompt. Để trống nhãn để hiện tên gốc. Tìm kiếm
  được theo cả nhãn và tên/ID gốc; tooltip vẫn có tên gốc. Nhãn lưu cùng tuỳ chọn
  chat qua reload và được giữ khi chuyển tiếp.
- Sửa ID dùng cùng khoá với chuyển chat để tránh tự chuyển giữa lúc đang lưu.
  Xác minh tên native sau rename; lỗi lưu/đổi quyền khôi phục tên và tuỳ chọn.
- Lệnh tiếp tục tự thêm đúng một câu: **“Mã ID và nhãn chỉ để nhận diện chat,
  không đưa vào repo.”** Áp dụng cho Thường, Goal và Plan.
- Chuyển **Goal** chỉ cần nhập mục tiêu, tối đa 4000 ký tự; không yêu cầu khung
  MỤC TIÊU / HOÀN TẤT KHI. Giữ mục tiêu native đang có và các ràng buộc chống
  tự mở rộng phạm vi.

## Sửa vòng lặp chuyển chat khi vượt ngưỡng

- Chuyển tự động chọn tốc độ khả dụng từ catalog sau khi xác nhận chat nguồn
  đã dừng. Nếu Ultrafast không được hỗ trợ thì dùng Fast (hoặc Standard nếu
  Fast cũng không có); lưu tốc độ yêu cầu/thực tế và hiện thông báo trên chat.
  Không thay model, Goal, mức reasoning hoặc quyền. Lựa chọn thủ công vẫn được
  kiểm tra nghiêm ngặt, không âm thầm đổi tốc độ.
- Lỗi preflight chưa thực hiện chuyển được giữ theo lượt/model/tốc độ/cài đặt;
  không xoá rồi thử lại mỗi 100ms. Giữ nguyên lỗi khi poll và qua reload. Lượt
  mới, thay đổi cài đặt chuyển, bật lại Auto resume hoặc chuyển thủ công cho
  phép thử lại. Goal paused/hoàn tất không bị tự kích hoạt lại; sự kiện người
  dùng kích hoạt Goal sẽ mở lại điều kiện theo dõi tương ứng.
- Đã tái hiện số đo 709484/828400 = 85.645% tại ngưỡng 85%, Goal + Ultrafast
  không có trong catalog: chỉ tạo một successor, dùng Fast thật trong request,
  giữ Goal/Ultra và không còn lặp trạng thái.

## Toàn quyền cho chat mới và Auto Allow riêng từng chat

- Chat tạo hoàn toàn mới từ Tracker mặc định **toàn quyền**, với
  `approvalPolicy: never` và profile `:danger-full-access` ngay ở `thread/start`
  và lượt đầu. Không còn rơi về mặc định read-only của app-server.
- **Tuỳ chọn chat → Auto Allow** bật/tắt riêng theo ID. Chat mới từ Tracker bật
  sẵn; chat chuyển tiếp kế thừa lựa chọn và bản quyền trước đó. Lựa chọn tồn tại
  qua reload và mở lại chat; không sửa config Codex chung hay chat khác.
- Bật trong một lượt cũ đang read-only: các yêu cầu duyệt Terminal/sửa file
  được Tracker quan sát sẽ được tự trả lời Allow once, gồm yêu cầu đang chờ.
  Không cần ngắt và gửi lại công việc. Lượt tiếp theo dùng native Full access.
- Tắt: ngừng tự duyệt yêu cầu mới ngay; quyền trước khi bật áp dụng từ lượt kế
  tiếp theo cơ chế của Codex. Chat mới từ Tracker trở về quyền workspace và
  on-request khi tắt. Không thu hồi được lệnh đã chạy/đã duyệt.
- Không trả lời hộ câu hỏi người dùng, quyết định triển khai Plan, MCP/app
  approvals, yêu cầu cấp quyền bổ sung hoặc tự sửa quy tắc duyệt lệnh toàn cục.
  Native policy từ chối thay đổi được báo lỗi; không giả báo đã bật thành công.

## Auto resume và vòng đời Goal

- **Auto resume** chuyển chat khi đạt ngưỡng context **HOẶC** Codex bắt đầu tự
  compact. Dùng chung công tắc hiện có, không cần bật thêm tuỳ chọn. Điều kiện
  được kế thừa sang chat kế tiếp. Tắt Auto resume sẽ tắt cả hai điều kiện.
- Theo dõi trực tiếp `item/started: contextCompaction` trên kết nối Codex hiện có;
  dừng lượt và Goal trước khi đọc metadata để tạo chat kế tiếp. Compact thủ công
  (`/compact` hoặc nút Compact) được nhận diện từ lệnh gửi và giữ nguyên.
- Ngưỡng và sự kiện compact dùng chung khoá chuyển tiếp, nên đồng thời xảy ra
  cũng chỉ tạo một chat. Giữ model, reasoning, tốc độ, context và quyền của luồng
  chuyển tiếp hiện có; Goal native đang hoạt động được giữ sang chat mới.
- Khi chuyển từ chat có Goal: dừng chat cũ; lưu mục tiêu vào nhật ký; nếu chat mới
  là Goal thì lưu và xác minh Goal mới ở trạng thái `paused`; xoá và xác minh
  Goal cũ; sau đó mới kích hoạt chat mới. Không xoá nội dung chat/lịch sử cũ.
  Xoá thất bại thì chưa chạy chat mới. Nếu bị ngắt giữa chừng, nhật ký giữ ID chat
  mới/mục tiêu và Goal đã chuẩn bị vẫn còn, không tự gửi lại lệnh chưa rõ kết quả.
- Tracker ngắt khi nhận tín hiệu bắt đầu compact; không thể bảo đảm chặn một
  request đã rời Codex trước khi tín hiệu đến. Cần Codex đang kết nối và Tracker
  đang hoạt động. Các Goal tạm dừng từ phiên bản cũ không bị xoá hàng loạt.

## Bố trí header và nút điều khiển

- Thông tin runtime hiển thị thẳng tên model, bỏ nhãn **Model**. Trạng thái như
  **Completed** chỉ nằm ở góc trên phải của header; dòng thư mục và runtime bên
  dưới dùng toàn bộ bề ngang, giữ badge Ultra/Ultrafast.
- Bỏ nhãn **USAGE**; nút đồ thị dùng icon đường biểu diễn, vẫn có tooltip và
  trạng thái bật/tắt. Nút kiểm tra khả năng gửi trong khung soạn tin nằm sát
  bên phải, kích thước gọn cả ở panel hẹp.
- **Deactive** không phụ thuộc việc tải được Codex, xác định tài khoản hoặc
  trạng thái chờ reload. Chỉ khóa trong lúc đang xử lý để tránh bấm trùng.
  Thao tác vẫn xóa phiên đăng nhập cục bộ như trước; không cần app-server hoạt động.

## Tốc độ và hộp thoại proxy

- **Chat mới** và **Chuyển sang chat mới** có lựa chọn **Standard / Fast /
  Ultrafast**. Chat mới nhớ lựa chọn riêng của Tracker; chuyển chat điền sẵn tốc
  độ của chat nguồn. Auto resume kế thừa tốc độ native mới nhất, kể cả khi đã
  đổi trực tiếp trong Codex. Áp dụng cho Thường, Goal và Plan từ lượt đầu.
- Mức khả dụng lấy từ catalog của runtime cho từng model. Mức không được model
  công bố bị khóa; Tracker báo lỗi trước khi gửi thay vì âm thầm chuyển xuống
  Standard. Không sửa catalog, config Codex chung hoặc quyền truy cập của tài khoản.
- **ULTRA** (reasoning) có badge tím, **⚡ ULTRAFAST** có badge vàng và tên model
  đậm hơn. Ô chọn Ultrafast cũng được nhấn màu riêng; đây là hai thiết lập khác nhau.
- Chuột phải nút **Khởi động lại proxy** mở một hộp thoại gồm công tắc tự khởi động
  lại, thời gian im lặng và chọn EXE. Chọn file chỉ sửa bản nháp; icon Lưu mới áp
  dụng. Mở/lưu hộp thoại không gửi lệnh restart thủ công. Chuột trái vẫn restart
  như trước. Nếu lưu thiết lập kèm đường dẫn thất bại, đường dẫn cũ được khôi phục.

Tốc độ truyền bằng `serviceTier` của từng thread/turn; Fast dùng ID `priority`,
Ultrafast dùng `ultrafast`, Standard dùng `default`. Runtime lưu lựa chọn để mở
lại chat. [Tài liệu tốc độ Codex](https://learn.chatgpt.com/docs/agent-configuration/speed)
và [App Server](https://learn.chatgpt.com/docs/app-server).

## Chuyển sang Thường, Goal hoặc Plan

Hộp thoại **Chuyển sang chat mới** có mục **Chế độ bắt đầu**:

- **Thường**: tiếp tục như trước; đây là mặc định cho các bản ghi cũ.
- **Goal**: một ô mục tiêu, điền sẵn từ Goal hiện tại nếu có. Chỉ cần nhập mục tiêu,
  tối đa 4000 ký tự. Tracker không
  đặt budget token. Chuỗi Auto resume giữ Goal và đọc mục tiêu native mới nhất.
- **Plan**: lượt đầu ở Plan native và chờ quyết định triển khai sau khi lập xong.
  Plan chỉ áp dụng cho chat kế tiếp; lần tự chuyển sau trở về Thường.

Goal nhận ngữ cảnh bàn giao trước khi được kích hoạt: câu tiếp tục, deeplink,
nội dung thêm và ràng buộc phạm vi/điểm dừng. Không tự thêm việc ngoài yêu cầu,
không coi đề xuất chưa chấp thuận là nhiệm vụ, không lặp lại kiểm tra đã đạt khi
không có thay đổi, và kết thúc khi đạt tiêu chí. Nếu không đọc được lịch sử hoặc
chưa rõ yêu cầu thì hỏi người dùng. Ràng buộc được chèn tự động, còn mục tiêu
native giữ đúng nội dung người dùng đã nhập.

Goal native tự khởi chạy khi được kích hoạt; Tracker không gửi thêm lượt thường.
Không tự chạy lại Goal đã pause, hoàn tất hoặc xóa. Nếu người dùng thay Goal
trong lúc Tracker đang chờ chuyển, việc tạo Goal kế tiếp bị hủy. Lỗi hay mất xác
nhận không dẫn tới tạo lại, gửi lặp hoặc âm thầm dùng chế độ Thường.

Hai nút **Cài đặt / Xóa** nằm bên phải dòng Context, không còn ở dòng tiêu đề.
Xóa vẫn chỉ xuất hiện ở chat không chạy. Panel hẹp rút gọn chữ Context và giữ
tooltip đầy đủ, hai nút không tràn hoặc xuống dòng.

## Tuỳ chọn riêng từng chat và fit danh sách

Mỗi dòng chat có nút **⚙ Tuỳ chọn chat**; chat đang xem cũng có nút này cạnh
**Chuyển sang chat mới**. Phần Theo dõi context cũ được thu lại thành nút cài đặt.
Hộp thoại chỉnh các giá trị của đúng chat đó:

- Thời gian chờ mở chat kế tiếp, tính bằng giây (0–3600).
- Chu kỳ kiểm tra context, tính bằng ms (100–60000).
- **Ngưỡng chat hiện tại (%)**, từ 1–99, áp dụng từ lần kiểm tra kế tiếp và giữ
  nguyên trạng thái bật/tắt Auto resume. Không cần chuyển chat để đổi ngưỡng.
- Bật/tắt **Âm báo hoàn tất**. Âm lỗi, chờ duyệt và các loại khác vẫn theo cài đặt chung.

Lưu bằng icon đĩa mềm hoặc Ctrl+Enter. Đóng trước khi lưu không áp dụng thay đổi.
Tuỳ chọn tồn tại qua reload theo từng ID; không đổi chat khác hay mặc định chung,
không tự bật Auto resume. Thời gian/âm thanh riêng không tự truyền sang ID kế tiếp;
ngưỡng chuỗi tiếp tục kế thừa như trước. Công tắc âm
chung vẫn được tôn trọng. Hộp thoại chuyển chat lấy thời gian chờ của chat gốc
làm giá trị ban đầu. Ngưỡng trong hộp thoại chuyển được ghi rõ là **Ngưỡng chat
kế tiếp (%)**; model, context, Auto resume và ID chuỗi cũng chỉnh ở đó.

Ở chế độ danh sách nằm trên nội dung chat, double-click thanh **Resize chat
list height** để fit toàn bộ kết quả đang hiển thị sau khi lọc. Chiều cao mới
được nhớ. Nếu danh sách dài hơn màn hình, dùng tối đa chiều cao và cuộn danh sách;
vẫn kéo thanh resize được để dành lại chỗ cho nội dung chat.

## Chủ động chuyển sang chat mới

Chọn cuộc trò chuyện trong Tracker rồi bấm **Chuyển sang chat mới**. Hộp thoại
cho chọn **model**, **context chat kế tiếp**, thêm nội dung vào lệnh tiếp tục,
đặt **ID chuỗi** (tối đa 30 chữ/số), số kế tiếp, **Auto resume**, ngưỡng
**1–99%** và thời gian chờ. Model mặc định lấy từ chat gốc; đổi model cập nhật
các lựa chọn context theo model đó. Bấm **Chuyển chat** hoặc Ctrl+Enter để xác nhận.
Hủy không thay thiết lập hoặc dừng chat; bản nháp được giữ riêng theo chat.

Tracker dừng lượt đang chạy nếu có, chờ khoảng thời gian đã cài, tạo chat kế
tiếp và gửi câu `Tiếp tục` kèm liên kết về chat cũ theo mã chuỗi. Workspace,
mức reasoning và quyền được kế thừa. Nội dung thêm được nối sau liên kết bằng
một dòng trống, giữ xuống dòng bên trong. Model và context sử dụng lựa chọn
trong hộp thoại; Auto resume, ngưỡng, context và ID được giữ cho chuỗi kế tiếp.
Thiết lập riêng trong hộp thoại được ưu tiên hơn quy tắc chung cho chat mới.
Không cần bật Auto resume hoặc đợi chạm ngưỡng mới được chuyển thủ công.
Chat gốc cần được mở trong Codex ở cùng cửa sổ VS Code.

Nút khóa trong lúc chuyển và sau khi đã chuyển. Nếu thao tác bị gián đoạn,
Tracker giữ trạng thái để kiểm tra, không tự gửi lặp; dùng **Mở chat kế tiếp**
nếu chat mới đã được tạo. Lệnh **Codex Tracker: Chuyển chat đang chọn sang chat mới**
trong Command Palette thao tác với chat đang chọn trong Tracker.

Nút **♫ Cài đặt âm thanh** nằm cùng hàng với **Đang chạy / Không chạy**,
mở hộp thoại riêng. Chat không chạy dùng chấm trạng thái màu xám; xóa chat,
hủy xóa hoặc quay lại từ hộp thoại xác nhận giữ nguyên tab đang xem.
Dòng tài khoản gộp thành `Context 14% of 828K`, làm tròn số; bỏ hiển thị tok/s.
Các nút lưu dùng icon đĩa mềm có tooltip, ô ngưỡng thu vừa hai chữ số.

## Plan xong, chờ xác nhận

Tracker hiển thị và phát lời báo **“Đã lập xong kế hoạch. Có triển khai luôn không?”** khi Codex hiện **Implement this plan?**,
kể cả khi backend báo `idle`. Đây là kết thúc giai đoạn lập kế hoạch, chưa phải đã
triển khai xong. Câu mới dùng clip tiếng Việt riêng, được điều khiển bởi công tắc
**Chờ trả lời**; lời nhắc theo thời gian vẫn như trước. Không phát thêm
âm “hoàn tất tác vụ” cho cùng giai đoạn này.

Trạng thái được xóa khi bạn trả lời, Skip/đóng câu hỏi hoặc bắt đầu lượt mới.
Đổi sang chat khác không được hiểu là đã trả lời. Nhận diện dựa trên sự kiện plan
thực và trạng thái `implementPlan` của giao diện, không dò chữ trong nội dung chat.
Observer chỉ gửi ID chat/lượt, không gửi nội dung plan và không tự trả lời hộp thoại.

## Âm thanh và chat mới

**Cài đặt âm thanh** mở từ nút ♫ cạnh hai tab: công tắc tổng, mười loại
âm báo, bật hết/tắt hết và nghe thử. Lựa chọn tự lưu. Quota dùng lại giọng đã có;
các công tắc quota cũ đồng bộ với vùng này.

Hai lời báo mới: **“Codex đã hoàn tất tác vụ”** và **“Codex đã dừng do lỗi”**.
Thông báo dựa vào trạng thái kết thúc lượt thật từ Codex; lỗi công cụ hoặc retry
chưa kết thúc lượt không phát lời báo dừng. Dừng thủ công thông thường, compact,
agent con và chat đang tự tiếp tục không phát lời báo hoàn tất. Runtime bị lỗi
khi còn lượt đang chạy được xử lý như dừng do lỗi. Cùng một lượt chỉ báo một lần;
lỗi 429/quá tải ưu tiên âm riêng nếu bật, nếu không dùng âm lỗi chung. Âm quá tải
vẫn có khoảng cách năm phút theo chat. Tắt âm không phát bù các sự kiện đã bỏ qua.

Trong **Chat mới → Auto resume**, chọn ngưỡng và một trong ba phạm vi:

- **Mọi chat mới**: Codex, Tracker và chuyển tiếp.
- **Chat mới từ Tracker**: chỉ nút Chat mới của Tracker.
- **Chat chuyển tiếp**: chỉ chat kế tiếp khi chạm ngưỡng.

Mặc định tính năng tắt. Khi bật, áp dụng cho chat mới; mở lại chat cũ không tính
là chat mới. Chat cũ và thiết lập thủ công giữ nguyên. Chuỗi đang được theo dõi
vẫn kế thừa ngưỡng như trước; quy tắc mới chỉ thay ngưỡng kế thừa khi đúng phạm vi.
Tắt theo dõi trong khi đang chuyển tiếp vẫn được tôn trọng.

Danh sách ưu tiên tab **Đang chạy** khi mở/hiện lại. Ở một cột, tự dành đủ chiều
cao cho cả danh sách khi vừa màn hình; nếu thiếu chỗ, ưu tiên một chat trọn vẹn.
Khi màn hình quá thấp, cuộn phần đầu để thấy chat. Đổi một/hai cột cũng tính lại.
Nút vòng tròn viền vuông biểu diễn đúng tỷ lệ context; bấm để theo dõi, nền xanh
khi bật. Chỉ bấm đúng nút vòng tròn mới bật/tắt; chữ và khoảng trống bên cạnh
không thao tác. Dòng thẻ chat gọn thành **57.8% / 85% of 828,4K**.

## ID, model và trạng thái chọn

- **ID chuỗi** nhận chữ thường, chữ hoa, số và tiếng Việt; ví dụ `dựÁn09`, `abc1`, `123`. Giữ nguyên hoa/thường, chuẩn hóa dấu Unicode; tối đa 30 ký tự, không khoảng trắng.
- Hộp thoại **Chat mới** có ô **Model**, lấy danh sách từ Codex đang chạy. Chọn model sẽ cập nhật context và được nhớ cho lần sau. Model không còn khả dụng sẽ bị chặn trước khi tạo chat.
- Thẻ context đang chọn có nền xanh, viền cyan và dấu **✓**. **Chat mới** và nút tạo dùng màu xanh rõ, không phụ thuộc màu nhạt của theme. Chat/tab đang chọn cũng được tô rõ.
- Chú thích rút gọn: “Dùng 570K”, “Đã nhớ.”

## Âm báo tiếng Việt đã duyệt

Beep khi chat bắt đầu chờ được thay bằng đúng hai câu:

- Chờ duyệt: **Codex đang chờ duyệt thao tác**.
- Chờ trả lời: **Codex đang chờ câu trả lời của bạn**.

Hai file `approval_initial.wav` và `input_initial.wav` được phát cục bộ từ bộ nhớ.
Nếu cả hai trạng thái cùng xuất hiện, phát lần lượt hai câu; nếu chỉ thêm một
trạng thái chờ mới, chỉ đọc câu tương ứng. Không đọc lại ở mỗi lần quét.
Lời nhắc sau 5/10/15 phút, quota, MP3 lỗi 429 và model quá tải được giữ nguyên.
Nếu đã chủ động chọn MP3 riêng cho chờ người dùng, lựa chọn đó vẫn được ưu tiên.
Lệnh nghe thử âm báo chờ người dùng phát cả hai câu mặc định khi không có MP3 riêng.

Tạo lại riêng hai clip khi cần: `python scripts/generate_attention_voice.py --scratch <thư-mục-đã-kiểm-tra-quyền> --only approval_initial input_initial`.
Trình tạo dùng cùng giọng tiếng Việt với bộ lời nhắc có sẵn và bỏ qua file đã có;
Tracker không gọi dịch vụ tạo giọng nói lúc chạy.

## Hộp thoại tạo chat mới

Bấm **＋ Chat mới** để mở hộp thoại ngay trong Tracker. Thư mục làm việc, bốn
mức context và ô soạn yêu cầu nhiều dòng nằm cùng một form. Nút **Duyệt…** mở
bộ chọn thư mục của hệ điều hành. Context vừa chọn được tự lưu và chọn sẵn lần
sau; tất cả dung lượng hiển thị bằng K.

**Enter** xuống dòng, **Ctrl+Enter** (hoặc **Cmd+Enter**) tạo chat. Hủy hoặc Esc
giữ bản nháp để mở lại; cập nhật trạng thái nền không làm mất nội dung đang gõ.
Trong lúc tạo, form khóa nút gửi và đóng để tránh thao tác trùng. Lỗi xuất hiện
ngay trong form; nếu chat đã được tạo nhưng không mở được sidebar, dùng **Mở chat
đã tạo**. Kết quả chưa xác nhận không được tự gửi lại. **Tạo tác vụ khác** bắt đầu
một bản nháp trống sau khi đã kiểm tra tác vụ trước.

Nút **⚙** cạnh Chat mới mở cùng hộp thoại ở chế độ cài đặt context, không tạo task.
Lệnh **Codex Tracker: Tạo chat mới với context riêng** trong Command Palette cũng
mở hộp thoại này. Giao diện dùng tiếng Việt UTF-8, hỗ trợ bàn phím, giữ focus trong
hộp thoại và cuộn nội dung ở panel hẹp.

## Context riêng khi tạo chat

- Bấm **＋ Chat mới** trong Tracker, chọn thư mục và context, nhập yêu cầu rồi bấm **Tạo chat**. Đây là một thread mới hoàn toàn, không mang lịch sử task khác vào.
- Tracker **tự nhớ lựa chọn context vừa chọn** và chọn sẵn đúng mức đó lần sau, kể cả sau khi reload VS Code. Ví dụ chọn 600K thì lần tạo tiếp theo mở ở 600K. Khi chưa từng chọn, dùng mục mặc định của model. Đóng hộp thoại vẫn giữ lựa chọn context vừa chọn.
- Nút **⚙** cạnh Chat mới cũng cho đổi lựa chọn đã lưu. Trong **Theo dõi context**, **Đổi context ⚙** đặt riêng mức cho chat kế tiếp của chuỗi; các chat kế tiếp kế thừa lựa chọn đó. Chỉnh riêng một chuỗi không thay đổi lựa chọn gần nhất của luồng tạo chat mới.
- Có bốn mức: **Mặc định của model**, **400K**, **600K**, **900K**. Mặc định của model đọc từ catalog; không cố định 272K. Nhãn context dùng đơn vị **K**, ví dụ `272K`, `258,4K`; số token gửi tới Codex vẫn giữ nguyên.
- Với gpt-6-astra / CLI 0.164.0-alpha.11.1 đã kiểm chứng: mặc định 272K → 258,4K dùng được; 400K → 380K; 600K → 570K; 900K bị giới hạn 872K → 828,4K dùng được. Giá trị phụ thuộc model/catalog; chọn 900K không mở khóa giới hạn phía máy chủ.
- Cấu hình chỉ được gửi vào `thread/start` cho chat đó. Tracker lưu override trong global storage `chat-contexts` và áp lại khi mở đúng ID qua `thread/resume`. Cần bridge của Tracker hoạt động trước khi mở lại chat; mở từ Tracker sau reload để bảo đảm kết nối sẵn sàng. Không sửa `config.toml` chung.
- Ngưỡng auto-compaction đặt ở 90% phần context dùng được dự kiến (85% cửa sổ yêu cầu khi thiếu metadata), đếm tổng context. Ngưỡng chuyển chat của Tracker vẫn chỉnh riêng như trước.
- Luồng tạo mới yêu cầu tin nhắn đầu tiên vì app-server không lưu/mở lại được thread trống chưa có lượt. Nếu đã tạo nhưng gửi/mở giao diện thất bại, thông báo giữ ID để kiểm tra, không tự tạo lại hay gửi lại.

Kiểm chứng: `scripts/test.ps1`, `scripts/ui-test.ps1`, `scripts/ui-test.ps1 -TestFile new_chat_dialog_ui.py`, và `scripts/test.ps1 test/context_window_smoke.js` với `CST_CODEX_EXTENSION_ROOT` trỏ tới extension Codex đã cài. Smoke test dùng CLI thật với model endpoint loopback, kiểm tra bốn mức, tách lịch sử và khởi động lại tiến trình; không gọi model bên ngoài. Test Edge kiểm tra tiếng Việt, context K, soạn nhiều dòng, bản nháp, bàn phím, lỗi, chống tạo trùng và layout hẹp.

Tài liệu chính thức: [cấu hình context và auto-compaction](https://learn.chatgpt.com/docs/config-file/config-reference), [tạo và mở lại thread qua app-server](https://learn.chatgpt.com/docs/app-server).

## 0.12.34

Automatic context handoff now carries the source chat's approval policy and
permission profile into the new thread and its first turn. Full access remains
Full access; restricted chats retain their restrictions. Missing source
permission metadata stops the handoff before any successor message is sent.
Use **Tuỳ chọn chat** to change the delay between fully stopping
the old chat and opening its successor (0–3600 seconds; default 10 seconds).
The setting survives reloads, and the card shows the remaining wait. If the
source chat resumes during that delay, Tracker cancels creating the successor.

Chats waiting for approval or user input speak the corresponding approved sentence on entering that state and
then speak a bundled Vietnamese reminder every five minutes while still waiting:
“Đã 5 phút chưa xác nhận” or “Đã 5 phút chưa có câu trả lời”, increasing to
10, 15 minutes and onward. Common milestones use complete prerecorded sentences;
longer waits use bundled number recordings. Playback is entirely local and
does not use Windows speech voices, download speech or create temporary files.
Resolving the request stops
reminders immediately; each chat has its own reminder timer.
Tracker reads live Codex status every second, including while its panel is hidden.
**Cần duyệt** and **Cần trả lời** badges appear beside the chat, with waiting chats
first in the list, a clickable banner and a status-bar alert. Badges clear when
the request is resolved; ordinary polling does not repeat the initial announcement.

## Theo dõi context và chuyển tiếp chat

Nút vòng context cạnh từng chat bật/tắt theo dõi. Mỗi chat có ngưỡng riêng
(1–99%, mặc định 80%). Nút **Tuỳ chọn chat** đổi thời gian chờ, chu kỳ kiểm
tra, ngưỡng hiện tại và âm hoàn tất của chat đó. Ngưỡng và Auto resume của chuỗi kế tiếp chọn
trong hộp thoại **Chuyển sang chat mới**. Theo dõi vẫn chạy khi ẩn Tracker.

Trong hộp thoại chuyển chat, nhập **ID chuỗi** (1–30 chữ hoặc số, hỗ trợ tiếng Việt,
giữ hoa/thường) và **Số kế tiếp**. Ví dụ ID `DUAN`, số `25`
cho chat kế tiếp `[DUAN-0025] Tiếp tục`, rồi `0026`, `0027`… Tên chat hiện tại
không đổi. Thiết lập riêng từng chuỗi, lưu qua reload; chat kế tiếp kế thừa mã
và tự tăng số, kể cả khi đổi tên chat. Để trống ID để đặt mã theo
tên chat. Đặt ID không tự bật theo dõi context. Khi một chat đã bắt đầu chuyển
tiếp, chỉnh ID ở chat kế tiếp để tránh đổi tên yêu cầu đã gửi.

Khi đạt ngưỡng, Tracker tạm dừng goal nếu có, gửi lệnh Stop vào đúng lượt đang
chạy và chờ xác nhận chat cũ cùng các task con đã dừng. Sau đó đọc tên chat cũ,
tạo chat mới cùng workspace/model và tự gửi, ví dụ:

`[QHTT-0002] Tiếp tục codex://threads/<ID-chat-cũ>`

Tên bắt đầu bằng `[ID-0001]` giữ nguyên mã (chữ/số, hỗ trợ tiếng Việt,
tối đa 30 ký tự) và tăng thứ tự, giữ ít nhất 4 chữ số. Chat chưa có mã được
đặt `[ABCD-0001] Tên cũ` bằng 4 chữ hoa ngẫu nhiên; chat kế tiếp là `0002`.
Chat mới kế thừa ngưỡng và được theo dõi tự động, chat cũ ngừng theo dõi.
Các chat không đánh dấu không được chuyển tiếp. Tự compact bị nhường quyền
cho tính năng này trên chat đã đánh dấu. Proxy recovery không tự chạy lại
chat đã dừng để chuyển tiếp.

Context dùng `last_token_usage.total_tokens / model_context_window`, cùng
cách tính với Codex. Chu kỳ 300 ms là chu kỳ đọc log cục bộ, không gọi model
hay API quota; số liệu chỉ thay đổi khi Codex ghi bản cập nhật token mới.
Không có số liệu hợp lệ thì hiển thị `—` và không tự dừng.

Kích thước **Context window** hiện bằng đơn vị K (ví dụ `272K`)
ở từng chat, dòng Usage và bảng Theo dõi context. Giá trị lấy từ phiên tương ứng,
cập nhật theo dữ liệu context mới; khi chưa biết kích thước thì hiển thị `—`.

Nhật ký nhỏ trong global storage `context-handoffs` chống tạo/gửi lặp giữa
các cửa sổ và khi reload. Nếu mất xác nhận, Tracker hiện lỗi và giữ chat kế
tiếp (nếu đã tạo) qua nút **Mở chat kế tiếp**; không tự gửi lại yêu cầu chưa rõ
kết quả. Có thể bỏ đánh dấu khi chuyển tiếp để không tiếp tục chuỗi sau lần
chuyển đang thực hiện. Dừng và tạo chat cần kết nối Codex sở hữu chat trong
cửa sổ VS Code này. Deeplink trỏ về lịch sử cũ; đây là chat mới, không fork
toàn bộ context.

## Local verification on Windows

Use `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test.ps1`
for the Node suite and `scripts/ui-test.ps1` for the Edge checks. Both use the
ordinary Windows user token, a shared ACL-safe scratch helper, and cleanup in
`finally`. For the installed app-server loopback smoke, set
`CST_CODEX_EXTENSION_ROOT` to its installed extension directory and pass
`test/context_handoff_smoke.js` to `scripts/test.ps1`. It uses an isolated Codex
home and a localhost model fixture, so it consumes no account quota.

## Quota chart hover and completed task recovery

Hover over the quota graph to highlight the nearest sample and show its time
and used percentage. The tooltip stays inside the chart on narrow panels and
remains visible during background refreshes. Proxy restart recovery now retires
successfully completed tasks without sending an automatic continuation message.

## Context usage and compact/resume

The Usage row shows the selected chat's current context percentage beside the
quota percentages whenever Codex reports both the input token count and model
context window. The selected running chat also has a compact action that sends
the stop, compact and optional resume sequence through the existing Codex
app-server owner. The **Tự compact context** section in **Cấu hình cảnh báo
quota** can enable the automatic sequence and set an integer threshold from 1
through 99 percent. Automatic compaction runs once for each active turn and
does not start a competing Codex process.

Usage has a visible **Đồ thị** toggle for quota samples by time. The summary
and chronological views use separate colors; chronological view can be filtered
to the user/Codex dialogue only. The latest request and response cards expose
Copy buttons, and the composer keeps its input and text selection stable while
background activity refreshes.

## Vietnamese quota voice alerts

The Usage alert dialog can optionally read the primary quota percentage in
Vietnamese when two consecutive checks differ. The value is rounded and
clamped to an integer from 0 through 100. Normal changes and large changes
can be enabled independently; the large-change threshold is configurable from
1 through 100 percentage points. Windows speech synthesis is not used. Tracker
plays bundled full-sentence Vietnamese PCM WAV files for each integer percentage
locally. Full sentence context prevents words such as “ba” and “bảy” from being
misread as letter names. The feature is disabled by default and does not change
the existing MP3
error, model-capacity or user-input sound choices.

## Retry-limit error alerts, MP3 sound and history (0.12.15)

Tracker watches Codex rollout files in the background, including when its
panel is hidden. A failed `task_complete` or `turn_complete` with structured
`response_too_many_failed_attempts.http_status_code = 429` triggers one
MP3 playback per new error. The exact legacy error message
`exceeded retry limit, last status: 429 Too Many Requests` is also recognized.
Transient retries, unrelated HTTP 429 responses and quoted chat text do not
trigger the alert. This alert does not restart the proxy or send chat messages.

The package includes `media/error_429.mp3`, derived from the supplied
`Phung-Cong.mp3` clip and normalized to an actual MP3 stream. It plays once
per new matching error without extra setup. To replace it, run **Codex Tracker:
Chọn âm thanh lỗi 429 (MP3)** in the Command Palette. The selected absolute path is saved across
reloads; keep the file at that location. Use **Codex Tracker: Nghe thử âm thanh
lỗi 429** to play it once. Playback uses Windows MCI in a hidden process and
does not substitute system beeps. The bundled sound is used until another file
is selected. An unavailable or
invalid file preserves pending notifications for a later retry after selection.

## Session runtime diagnostics and stop

Running and selected sessions show the latest model, reasoning effort and
output-token speed when the rollout provides those records. The **Dừng** button
sends the app-server `turn/interrupt` request for the selected active turn and
reports unsupported or unconfirmed delivery instead of pretending that the
turn stopped.

Use **Codex Tracker: Xem lịch sử lỗi 429** in the Command Palette to open the
saved history. `codex-retry-errors.jsonl` lives in the extension's VS Code
global storage, outside this repository. Each entry includes occurrence and
detection time, conversation title, thread/turn identifiers and the error.
The first scan imports historical errors silently; new errors play the sound.
An error followed by a successful turn before the next scan is still recorded.

File cursors persist across reloads. Duplicate rollout copies and repeated scans
do not repeat a history entry or its notification. An exclusive history lock
coordinates windows. Failed history writes retry before advancing the cursor;
pending sound deliveries survive reloads. History is retained until removed by
the user; builds and repository cleanup do not delete it.

## Restart a local proxy (0.12.13)

The yellow restart icon on the compact **Trạng thái giao tiếp** row restarts
your local proxy EXE. On the first click, choose its `.exe`; Tracker saves the
absolute path in VS Code global extension state for subsequent sessions.
Expand the row and use **…** to change the executable. The tooltip shows the
saved path and latest result. Selecting a replacement path only saves it.
Hover the yellow icon to see the last successful reset (date/time, manual or
automatic, PID and stopped-process count), the last attempt, idle threshold,
running-task count, newest task activity and current watchdog decision.
Successful reset history persists across window reloads. A failed attempt
does not overwrite the last success; older versions did not retain this history.

Restart stops processes whose complete executable path matches the selected
file, rechecks each process before stopping it, waits for exit, and launches
the EXE with its own folder as the working directory. Same-named executables
elsewhere are left alone. With no matching process running, the button starts
the EXE. A missing file or stop failure aborts the restart and preserves the
saved path. The process runs with the current user's permissions and a hidden
window; proxy arguments and Windows-service control are not configured here.
The success message confirms process launch, not proxy endpoint readiness.

Commands: **Codex Tracker: Restart Local Proxy** and
**Codex Tracker: Choose Local Proxy EXE**. Packaging can put the installer
outside this checkout with `CODEX_TRACKER_VSIX_OUTPUT` set to an absolute
`.vsix` filename in an existing directory.

Right-click the yellow icon to enable/disable automatic restart, set the idle
threshold, or change the EXE. Automatic restart starts disabled; the initial
threshold is **5 minutes**. Both values persist. While enabled, background
observations run about every 15 seconds even when the Tracker is hidden and
scan all discovered task rollouts, including chats beyond the visible history
limit. There must be at least one unfinished running task, every such task
must have been inactive for the configured interval, and the observation must
be complete and fresh. A single recently active task prevents restart. Every
restart attempt records a persistent cooldown of the configured interval.

Before either manual or automatic restart, Tracker saves the original running
chat IDs and turn IDs in extension state. For up to ten minutes after restart,
it checks those chats and sends exactly **Tiếp tục công việc (nếu còn)** only
to an original chat that failed or was aborted after the snapshot. A successfully
completed turn is removed from pending recovery without sending a message,
including when a saved recovery plan is loaded again. A chat still running, or
one that has moved to another turn, is left alone. Definite non-delivery may
retry after ten seconds, at most six attempts with the same message UUID;
unknown delivery is retained without an automatic resend. Restart recovery
uses the existing Codex connection and does not open a separate Codex window.
Pending recovery no longer blocks the watchdog for the entire ten-minute
recovery window. A running chat still idle for the configured threshold may
trigger the next reset after the normal cooldown. If recovery attempts to send
a continuation, the watchdog waits for a fresh task scan before another reset.

Stopped-chat composers now attach the same input/event handlers as running
chats. Drafts survive polling and switching chats. Each send has its own
request ID; only the matching successful acknowledgement clears the unchanged
draft. Failed/unknown sends and text edited while sending remain in place.

## Compact account and single usage status item (0.12.11)

The account card contains the current email and **Deactive**, with no login
heading. **Usage** occupies one line inside that same card: remaining quota,
**↻** to check now, and **⚙** to change the interval. Reset times, other buckets
and the last successful check are available in the tooltip. There are no
progress bars or extra information rows. The interval dialog accepts 1–1440
minutes; the default is 5. Set 0 for manual checks. This preference survives
VS Code restarts, and automatic checks continue while the Tracker is hidden.
Overlapping checks share one request. Failed checks retain the previous values
with the error in the tooltip; missing usage is never presented as zero usage.

The single **Codex Usage** item on the right of the VS Code status bar shows
only the primary (5h) remaining percentage, for example `46%`. There are no
separate window labels or extra status items. Hover for all buckets, both
window percentages, reset times and the configured interval. Missing primary
quota is never replaced with the weekly percentage. The Usage row inside the
account card still shows both windows, for example `5h 55% - 7d 93%`, with
yellow and green percentages.
Click it, or run **Codex Tracker: Check Usage**, to refresh the same data shown
in the Tracker. Both locations show remaining quota; the tooltip identifies it. The
Command Palette also exposes **Codex Tracker: Set Usage Check Interval**.

Usage comes from `account/rateLimits/read` through the existing Codex Extension
connection. It uses the quota data documented in the
[official OpenAI documentation](https://developers.openai.com/codex/app-server/).
It does not estimate quota from chat messages or token counts.

The name of the conversation currently displayed in Codex is yellow in the
Tracker. This follows Codex's current local route, including changes made in
Codex itself, separately from the row selected in the Tracker. For multiple
Codex surfaces, the most recently focused one determines the current chat.
Leaving the chat route clears the highlight. Opening Tracker never navigates
Codex automatically.

After installing this update, reload the VS Code window once so the observer
loads with Codex. The observer is added to newly initialized webview HTML in
memory, using a Tracker-owned script. Native extension files on disk remain
untouched. It reads the committed router location, not conversation contents.
This integration follows the installed Codex implementation and can require
an update if the native webview internals change.

**Trạng thái giao tiếp** is collapsed to one line by default. Click the line,
or focus it and press Enter/Space, to expand the existing controls. Expanded
state, settings drafts and focus survive Tracker refreshes.

## Compact login card (0.12.8)

**Phiên đăng nhập Codex** shows the current account email and a single
**Deactive** button. The card contains no Codex Home path or explanatory text.
The account label comes from `account/read` on the existing Codex Extension
connection with `refreshToken: false`; Tracker does not read credentials to
display it. Account metadata is refreshed while the Tracker is visible.

## Open the selected conversation in Codex (0.12.7)

Click a conversation in **Đang chạy** or **Không chạy** to select its Tracker
details and open that exact existing thread in the Codex sidebar in the same
VS Code window. Enter and Space on a conversation row do the same. Selecting
the same row again reopens it after navigating elsewhere in Codex.

Navigation activates Codex when needed and uses its existing sidebar route
queue, including while the sidebar is loading. Rapid selections keep the newest
choice. Restoring Tracker state or polling never switches the Codex conversation.
If navigation fails, Tracker retains the selected details and shows an error.

This integration locates the running Extension URI handler without editing the
OpenAI extension or opening an OS protocol link. It depends on Codex internals;
unsupported layouts fail explicitly. Opening a conversation sends no prompt or
turn request. It does not use the queue, steer, or continuation APIs.

## Deactivate the current login (0.12.6)

Use **Deactive** in the **Phiên đăng nhập Codex** card,
or run **Codex Tracker: Deactivate (Xoá phiên hiện tại)** from the Command Palette.
The card is available even without a selected conversation. Deactivation targets
Tracker's configured `codexHome`, then `CODEX_HOME`, then `~/.codex`.

This follows Swapper Codex 0.3.0's deactivation mechanism: replace `auth.json`
with `{ "OPENAI_API_KEY": null, "tokens": null }`, then offer to reload VS Code.
Tracker writes the replacement atomically without reading, logging, or backing
up credentials. Conversation files, indexes, settings, and Swapper's saved
accounts are untouched. This clears the saved file login; it does not revoke
tokens on the server or clear other credential stores/environment API keys.

Choose **Reload ngay** to apply it in this window, or **Để sau** to defer
until **Developer: Reload Window**. Other running Codex windows need
their own reload to discard credentials already in memory. Deactivation does
not run automatically on activation or installation.

## Continue a completed conversation (0.12.5)

Open **Không chạy**, select a completed conversation, then enter the
next request and click **Tiếp tục chat** (or press **Ctrl+Enter**). Text and image
attachments are supported. This starts a new turn in the same thread; while a
chat is running the composer continues to show **Steer ngay** and **Gửi sau**.

Tracker finds the existing Extension owner, including threads still loaded by
its app-server after the webview stopped advertising ownership. If no owner is
found, the local Extension connection can resume the existing stopped thread.
It checks the backend thread and latest turn before sending. It does not spawn
another app-server or interrupt a running job. A lost acknowledgement is shown
as an unknown outcome and does not trigger an automatic resend. Drafts are
retained on failure, including when the selected conversation changes.

Verified with Extension **26.930.41038** and bundled CLI **0.160.0**. The current
`thread-follower-start-turn` IPC method uses version **2**. Fresh threads whose
backend returns `list_turns is not supported yet` are checked with
`thread/read(includeTurns: true)` instead. An isolated completed chat received
new turns through its existing owner in another VS Code window and completed
them; the test chat was then deleted. This test does not establish that every
gray-webview failure is resolved.

## Steer while the Codex webview is gray (0.12.4)

The native IPC owner discovery uses cached ownership, but native steer discovery
asks the webview for its role again. A non-responsive webview can therefore
return `no-client-found` even while its app-server and turn are still running.
Tracker now reports these two failures separately.

On activation, Tracker installs an opt-in bridge into the existing Codex
Extension host. It adds a provider to the existing app-server connection and
advertises the bridge through the existing owner IPC router. Tracker steer
checks `thread/loaded/list`, the live thread status, and the newest turn before
calling `turn/steer` with `expectedTurnId`. It does not spawn, resume, start,
interrupt, or replace the owning app-server. Native Codex followers retain their
original handlers. Deactivating Tracker restores those handlers.

The bridge binds existing objects using an in-process inspector session without
pausing execution or opening a debugger port. This is an internal Extension
integration, so a changed module layout may require another compatibility fix.
If the owning Extension host or app-server has died, it cannot steer that lost
turn. A timeout after sending remains an unknown outcome and is never retried
automatically.

Verified with installed Extension **26.930.41038**, bundled CLI **0.160.0**.
The investigated historical rollout records CLI **0.159.2**, model
**gpt-6.1-sol**; those values are separate from the currently installed runtime.
Live direct steer returned an ACK in 14 ms on the existing turn. During this
investigation the owner was restarted externally, so the live test proves the
direct backend route, while regression tests cover a non-responsive webview.
Provenance and the verification note are retained under `artifacts/checkpoints`.

## Saved event search (0.12.3)

Opening a log folder indexes request summaries and the original timeline records,
including `response.created`, delta events, completion, BODY, headers and errors.
Search and IN/OUT filters work on those event rows. Selecting an event opens its
own payload; the request/response/events tabs still open the corresponding files.
Timeline metadata is streamed when indexing. Event payloads are loaded on demand
with cached file offsets; opening a folder does not load all response bodies.

## Original client BODY boundaries (0.12.2)

- Each HTTP BODY record preserves one frame from the Codex HTTP client. Each
  WebSocket BODY record preserves one complete client message. Tracker no longer
  divides HTTP frames into 64 KiB pieces. These boundaries are not TCP packets or TLS records.
- Client captures retain every byte of the observed frame, including binary and
  UTF-8 fragments. SSE events are derived records alongside the original BODY.
- Removed the content capture size setting and plaintext pagination controls.
  Selected BODY records and saved files load in full. Historical divided/truncated
  captures retain their original limitations; their boundaries cannot be restored.
- Bridge messages that exceed its transport limit or cannot be queued produce
  explicit capture gaps rather than being divided or silently shortened.
- Runtime instrumentation version 2 must be deployed for this behavior. If the
  JSON hook is already enabled, disable it and enable it again after installing.

## Plaintext reader (0.12.1)

- Copy plaintext or headers using the VS Code clipboard.
- Live updates preserve the plaintext element and its scroll position; selecting
  another event or saved-file tab resets it.
- Colored HEADER/BODY/FINISHED labels explain metadata, content chunks and stream
  end milestones. FINISHED alone does not mean model success; `response.completed`
  is a separate semantic event. Proxy/native end records may include an assembled body.

VS Code tracker for Codex sessions with lifecycle-aware activity, queue/steer controls, a loopback transport Gateway, reversible proxy routing, and a dedicated traffic monitor.

This build targets **Codex in VS Code on Windows 10**.

## Client JSON hook, raw events and traffic files

Open **Codex Tracker: Open Traffic Monitor**, then **Bật hook JSON + Reload**.
This release bundles a Windows x64 Codex runtime built from upstream
`rust-v0.159.2` (`ff6aec96948b70d94983af2641a6b67c94faeff5`). It replaces
`chatgpt.cliExecutable` reversibly and retains the installed extension's sandbox
and code-mode helpers. Enabling checks the installed bundled CLI version and
the runtime SHA-256. **Gỡ hook JSON + Reload** restores the previous setting.
The original bundled executable is not overwritten.

The hook runs before JSON compression/signing and WebSocket framing/TLS.
Requests with no matching rules retain their exact JSON bytes. Responses are
observed in the shared HTTP body and WebSocket client before Codex reduces them.
SSE parsing preserves all event types, including `response.in_progress` and
unknown future events. The UI displays actual method, host, endpoint, response
ID, item ID, sequence number, and before/after body hashes. WebSocket JSON frames
are associated with their actual **GET** upgrade endpoint.

**Bộ lọc JSON outbound** accepts an array of exact host/method/path rules.
Operations use JSON Pointer (`add`, `replace`, `remove`), with optional
`conditions` and `protocol`. An empty array leaves requests unchanged.
For example, adapting the pointer to the observed payload:

```json
[
  {
    "id": "steer-text",
    "host": "chatgpt.com",
    "method": "POST",
    "path": "/backend-api/codex/responses",
    "conditions": [{"path": "/type", "equals": "response.create"}],
    "operations": [{"op": "replace", "path": "/input/0/content/0/text", "value": "New message"}]
  }
]
```

Filters can change JSON length. Model changes and unsafe JSON pointers are
rejected. A filter error or missing Gateway acknowledgement blocks that request
before upstream send. The temporary loopback bridge credential lives in a
directory with access restricted to the current Windows user and is removed on
deactivation; Codex authentication headers/files are not read by the bridge.
Request and response bodies are captured as requested.

### Capture limits and saved folders

Default capture mode is **Chỉ bắt POST / GET**. Other methods and transport-only
CONNECT/tunnel/TLS records are excluded when recording, independently of display
filters. **Tối đa request/phiên** accepts 1–10000 (default 1000). It counts logical
requests; accepted requests keep receiving their full response/events after the
limit is reached. Use **Phiên mới** to start a new capture session. This limit
does not block Codex network requests. Live display retains the latest 2500
events; saved files remain available after those rows leave the display.

POST/GET saving defaults to the Windows Documents folder's **Codex Logs**.
**Chọn nơi lưu** selects another directory. Existing requests finish in their
original folders; new requests use the new directory. Folder timestamps are UTC:

```text
Documents/Codex Logs/
  2026-10-02/<session timestamp>/backends/
    chatgpt.com/
      codex-responses/<request timestamp>-POST-<request key>/
        request.json
        request.body
        request.original.body         (only when modified)
        response.json
        response.body
        response.events.jsonl
        timeline.jsonl
      endpoints/<other endpoint>-<key>/<request folder>/
```

`/backend-api/codex/responses` has its own `codex-responses` directory. Backend
hosts are separate. Client-hook body files retain complete observed chunks;
the plaintext viewer loads the selected capture in full. Optional proxy/native
captures retain their encoding and any historical truncation metadata in `captures.jsonl`.
Capture gaps and disk errors are explicit; gaps have their own JSONL records.
Streaming outbound bodies that do not expose buffered bytes are marked
unavailable. The loopback bridge accepts at most 64 MiB per message; observation
queues are bounded. These limits report gaps rather than dividing BODY records.

**Mở log** opens a saved folder inside Traffic Monitor. Filter separately by
backend, endpoint, Responses group, method, session, and time. Saved requests
have request/response/events/timeline tabs with paged payload loading. **Live**
returns to active capture. Opening a folder never replays requests.

### Build and verification

`scripts/build-runtime.ps1` requires Git, Rust/MSVC, Node and OpenSSL for the
loopback TLS fixture. It pins the source revision, runs the client integration
fixture, copies the binary/licenses, records `runtime/manifest.json`, and runs
the checkpoint helper with fresh VS Code discovery. Incremental compilation is
disabled. It removes its Cargo target cache by default after retaining artifacts;
`-KeepBuildCache` opts into keeping that cache.

The shipped runtime uses the `dev-small` profile. Its runtime/version/hash and
source/toolchain provenance are separate from the installed Extension and its
official `bundledCli` provenance. Identical CLI version strings do not make the
two binaries identical.

Verification uses an ephemeral HTTPS/WSS loopback backend with a fixture-only
trusted leaf, without installing certificates or sending real model requests.
It checks longer JSON edits before zstd and WebSocket framing, unchanged model,
server-confirmed body hashes, all five requested events in order, rejected sends,
and complete POST/GET log files. See `artifacts/verification/client-runtime.json`.

```powershell
node --test test/*.test.js
powershell -NoProfile -File scripts/build-runtime.ps1
bash build-vsix.sh
```

## Optional Schannel instrumentation

Traffic Monitor now includes **Cài hook**, **↻ Codex PID**, and **Bật plaintext**.
Install the helper once, select the existing Extension app-server PID, then attach.
Python must be available on PATH. Dependencies are pinned in
`gateway/hook-requirements.txt` and installed in an isolated environment under
VS Code global storage. They are not installed into system Python.

This mode uses Frida to intercept Windows Schannel `EncryptMessage` before TLS
encryption and `DecryptMessage` after decryption, inside the existing process.
It does not change the backend URL, certificate trust, model, or thread owner.
Stopping capture detaches the interceptor; restarting Codex requires attaching
to its new PID. Hooks run without waiting synchronously for the dashboard.

Parsed events show **method + endpoint path**, not just the destination host:

```text
POST /backend-api/codex/responses
GET /v1/models
```

HTTP/1 headers and bodies are reconstructed across TLS records. HTTP/2 HPACK
headers are decoded with a separate decoder for each direction; DATA is linked
to the endpoint by stream ID. WebSocket frames retain their upgrade endpoint.
Authorization/cookie headers and query values are excluded from recorded
metadata. Body capture is explicitly enabled by **Bật plaintext** and is bounded
by the configured capture limit. Header details are available by selecting the
corresponding `PLAINTEXT_HTTP_HEADERS` event. HTTP bodies are available as live
fragments and a bounded assembled `PLAINTEXT_HTTP_BODY_FINISHED` event.

If the hook attaches after a connection's headers were sent, the endpoint can
be unknown. Missing HPACK state is reported as `ENDPOINT_UNAVAILABLE`; unknown
raw bytes are discarded rather than guessed or persisted as an HTTP body.

### Outbound modification

`NativeInstrumentation.setOutboundRules()` installs host-scoped, equal-length
byte substitutions before `EncryptMessage`. No rules are active by default;
the user-specific filter interface is pending the requested filter definition.
Each actual edit produces `PLAINTEXT_OUTBOUND_MODIFIED` with before/after hashes.
This event proves a local plaintext edit, not remote server acceptance.

This primitive cannot change HTTP body lengths, repair compressed bodies,
reassemble matches spanning TLS records, or edit decoded masked WebSocket JSON.
Those operations need an HTTP client hook before compression/framing. The
Schannel adapter does **not** support arbitrary JSON transformation; use the
client JSON runtime above for that.

### Verified coverage and remaining limitation

The installed Extension discovered for this work is `openai.chatgpt`
`26.928.31416`, with bundled CLI `0.159.2`. The binary contains both Schannel
and Rustls. The Schannel interceptor attaches to the existing bundled
app-server and has been verified with a real Windows loopback TLS exchange:
outbound and inbound plaintext, endpoint extraction, and a server-confirmed
same-length body edit. No real model request was generated by this test.
An additional observe-only attach to the installed Codex app-server saw real
outbound/inbound Schannel plaintext for `POST /otlp/v1/metrics`. This is
telemetry evidence; it does not establish model/steer payload coverage.

**Rustls traffic is not intercepted by this Schannel hook.** In particular,
the presence of hooks in a Codex process is not proof that its Responses or
WebSocket transport uses them. The UI distinguishes `hook ATTACHED` from
`plaintext SEEN`. Full coverage of the current native client still requires a
verified Rustls/client-level adapter or an instrumented Codex runtime. This
adapter is experimental. The client JSON runtime above observes the shared
HTTP/WebSocket client across both TLS implementations.

Native helper tests (Windows, with the pinned dependencies installed):

```powershell
python test/h2_headers_test.py
python test/native_hook_integration.py
```

## Transport architecture

0.10.0/0.10.1 experimented with rewriting `chatgpt_base_url` to an HTTP localhost backend. That was the wrong layer for ChatGPT-authenticated Codex because workspace routing validates the application backend as an HTTPS origin.

0.10.2 no longer rewrites the ChatGPT backend URL.

Instead:

```text
VS Code Codex
    |
    | HTTP_PROXY / HTTPS_PROXY
    v
127.0.0.1:<gateway-port>
    |
    | CONNECT / ordinary forward proxy
    v
original HTTPS backend
```

The original destination remains `https://...`, so account/workspace routing still sees the real HTTPS origin.

When proxy mode or the proxy port changes, the Tracker reloads the VS Code window so the Codex extension starts with the new proxy environment.

Any legacy localhost `chatgpt_base_url` override created by 0.10.0/0.10.1 is automatically reverted before normal 0.10.2 startup.

## Gateway UI

Gateway settings are controlled from the Tracker UI rather than requiring manual edits.

Available controls include:

- local Gateway on/off;
- loopback port;
- Codex forward-proxy on/off;
- optional content capture where plaintext is available;
- capture-size limit;
- local trace rotation limit;
- one-click proxy enable + VS Code reload;
- one-click proxy disable / legacy route restore;
- dedicated Traffic Monitor.

The Gateway listens on `127.0.0.1` only.

## Dedicated Traffic Monitor

Open it with:

```text
Codex Tracker: Open Traffic Monitor
```

or **Mở Traffic Monitor** in the Tracker panel.

The monitor provides:

- visual **PAUSE ALL**;
- independent **PAUSE OUT**;
- independent **PAUSE IN**;
- direction filter: All / OUT / IN / Control;
- host/API filter when path information is available;
- text search;
- timestamps, byte counts, status, connection/request IDs;
- per-event details.

Pause controls freeze only the monitor presentation. They never pause or delay live Codex network traffic.

This is intentional: the diagnostic UI must not create the network stall it is trying to diagnose.

## HTTPS visibility

The 0.10.2 default transport is an ordinary HTTPS CONNECT pass-through proxy.

Therefore it can authoritatively observe:

- CONNECT destination;
- connection open/close/error;
- OUT byte flow;
- IN byte flow;
- timing;
- reconnect behavior;
- total bytes.

But HTTPS payload bytes remain encrypted inside the tunnel.

The UI must not label encrypted CONNECT bytes as a plaintext API request or response body.

Plaintext body/frame capture remains available for traffic that reaches the Gateway without an encrypted CONNECT tunnel. Exact HTTPS body inspection requires a separate trusted TLS-inspection or application-layer instrumentation mode.

## Steer semantics

A local steer acknowledgement is not proof that the remote server consumed the steer.

The Gateway keeps stages such as:

```text
LOCAL_CREATED
IPC_SENT
OWNER_DISCOVERED
OWNER_ROUTED
CORE_ACCEPTED
LOCAL_PERSISTED
UPSTREAM_REQUEST_OPENED
UPSTREAM_BYTES_SENT
UPSTREAM_RESPONSE_HEADERS
UPSTREAM_FIRST_EVENT
TURN_COMPLETED
```

Only evidence actually observed is emitted.

If the current transport exposes only encrypted tunnel bytes, the Tracker reports transport activity separately rather than fabricating model/API confirmation.

## Queue and Steer

### Steer ngay

Uses the currently running Codex Extension owner through its IPC path. It does not start a competing long-lived owner.

If delivery may already have happened before a disconnect/timeout, state remains unknown. The Tracker never silently retries and never silently converts steer to queue.

### Gửi sau

Uses the official Codex queue CLI flow for the exact thread.

## Legacy config recovery

The repository keeps the old config snapshot/revert helper only to safely migrate users who enabled the 0.10.0/0.10.1 localhost backend experiment.

0.10.2 does not create a new localhost `chatgpt_base_url` override.

## Privacy

Runtime traces are stored under the extension's VS Code `globalStorageUri`, not in the repository.

Authorization, cookies, API keys and secret-like headers are redacted from diagnostic logs. Sanitized diagnostic export excludes raw body content and headers.

## Build and install

Run tests:

```powershell
npm test
```

Build on Windows with Git Bash:

```powershell
& "C:\Program Files\Git\bin\bash.exe" ./build-vsix.sh
```

Expected artifact:

```text
codex-session-tracker-0.12.27.vsix
```

Install:

```powershell
code --install-extension .\codex-session-tracker-0.12.27.vsix --force
```

Then run **Developer: Reload Window** once.

## Clean generated repository files

Run `python cleanup_repo.py` to list generated installers, build/test caches,
screenshots and test logs without deleting anything. Run
`python cleanup_repo.py --delete` to remove that list. Source, tests, the main
Git database and JSON/Markdown verification records are preserved.

The full cleanup also removes the generated `runtime/bin` after checking that
an identical runtime exists in an installed Tracker extension. Installed
extensions and Codex accounts are outside its scope. Rebuild that binary with
`scripts/build-runtime.ps1` before packaging again, or use
`python cleanup_repo.py --delete --keep-runtime` to retain the packaging binary.

For double-click deletion on Windows, open **XOA_RAC.py**. It runs the same
guarded cleanup with `--delete` and waits for Enter afterwards so the result
stays visible. If Windows opens an editor, use **Open with → Python** for this
file. `cleanup_repo.py` without arguments remains a preview.

## Automated tests

```powershell
npm test
```

Gateway integration tests use local fake endpoints only. They do not call the real OpenAI service.
