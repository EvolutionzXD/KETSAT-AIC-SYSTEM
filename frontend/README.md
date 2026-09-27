# aic_final_frontend

Frontend cho backend **aic_backend_RRF_exp**: giao diện xanh biển, thao tác giống frontend RRF cũ, làm gọn để dùng trong phòng thi.
Gồm: `index.html` · `style.css` · `app.js` · `server.py` · thư mục `data/` (batch1, batch2, meta).

## Chạy

```bash
# Cửa sổ 1 — SSH tunnel tới server (giữ mở); backend chạy trên server bằng ./run_backend_exp.sh 8602
ssh -L 8602:localhost:8602 <user>@<server>

# Cửa sổ 2 — trong thư mục aic_final_frontend
python server.py                                   # mở http://localhost:8082
python server.py --backend http://127.0.0.1:8603   # tunnel dùng cổng khác
python server.py --port 8090                       # đổi cổng trang
python server.py --data E:\AIC_data                # thêm thư mục dữ liệu khác (lặp lại được)
```

Khi khởi động, `server.py` in ra `Backend … -> OK / KHÔNG KẾT NỐI ĐƯỢC`, số video / thư mục keyframe tìm thấy trên máy và dòng `OCR/ASR/keyframe` (dữ liệu đọc được từ `data/meta/`).
Trình duyệt chỉ gọi `http://localhost:8082`; `server.py` chuyển tiếp `/api/*`, `/health`, `/ws/*` tới backend và `/dres/*` tới DRES.
Chấm **● API** trên thanh trên cùng: xanh = backend OK, đỏ = mất kết nối (banner đỏ ghi rõ nguyên nhân, tự thử lại mỗi 5 giây).

## Dữ liệu trên máy (ưu tiên máy, thiếu thì lấy server)

Chép dữ liệu vào `data/batch1/` và `data/batch2/`, cấu trúc bên trong tuỳ ý:

```
data/batch1/.../L21_V001.mp4            ← video: tên file = Video ID
data/batch1/.../L21_V001/f_00001234.jpg ← keyframe (tuỳ chọn): thư mục tên = Video ID, file f_<frame 8 chữ số>.jpg
data/batch2/...
```

- Video / ảnh có trên máy được phát thẳng từ ổ cứng (tua nhanh, hover mượt). Không có thì `server.py` tự lấy từ backend.
- Chép thêm file trong lúc đang chạy cũng được (tự quét lại, tối đa 30 giây).
- Trong cửa sổ video, nhãn **📁 từ máy / ☁ từ server** cho biết video đang lấy ở đâu.
- Tên file khác backend một chút vẫn khớp: backend gọi `N051_V001` mà file là `N051-V001.mov` (hoặc ngược lại) vẫn phát từ máy.

### Video ở ổ đĩa khác (E:, ổ rời…)

**⚙️ Cài đặt → 📁 Thư mục video trên máy** → dán đường dẫn (vd `E:\AIC\batch2`, dán kèm ngoặc kép từ *Copy as path* cũng được) → **＋ Thêm**.
Có hiệu lực ngay, không cần khởi động lại; mỗi thư mục hiện số video tìm thấy, bấm **✕** để bỏ.

- Chọn thư mục chứa video, không nên chọn cả gốc ổ (`E:\`) vì quét lâu. Quét sâu 5 cấp thư mục con.
- Danh sách lưu ở `data/video_dirs.txt` (mỗi dòng 1 thư mục) — sửa tay file này cũng được, tự đọc lại trong ≤ 30 giây.
- Ổ rời chưa cắm: thư mục vẫn được giữ trong danh sách (hiện *không tìm thấy*), cắm vào là dùng lại được.
- Chỉ thêm / bỏ được từ chính máy chạy `server.py` (máy khác trong mạng LAN chỉ xem).
- Vẫn dùng được cách cũ: `python server.py --data E:\AIC_data`.

## OCR / ASR / keyframe / FPS trên máy (tuỳ chọn)

Chép **file gốc của backend** từ server vào `data/meta/` → `server.py` tự đọc và trả kết quả giống hệt API backend
(ô ✨, tab 📝 ASR / OCR, dải keyframe, tính frame/ms khi nộp đều lấy từ máy, nhanh và không phụ thuộc server).

1. Xem đường dẫn thật trên server (file cấu hình mà `run_backend_exp.sh` dùng):

```bash
grep -E "VIDEO_METADATA_PATH|OCR_RESULTS_PATH|ASR_BGE_SEGMENTS_PATH|FRAME_IDS_PATH|RRF_KCP_SEGMENTS_PATH" \
  /workingspace_aiclub/WorkingSpace/Personal/bachdx/AIC2026_Baseline/config/api.env
```

   Không có dòng `RRF_KCP_SEGMENTS_PATH` thì backend dùng `/workingspace_aiclub/WorkingSpace/Personal/bachdx/AIC2026_Baseline/event_segments_p25.json`.

2. Chép về (chạy trong thư mục `aic_final_frontend`; đường dẫn dưới đây theo cấu hình ngày 02/09, thay bằng kết quả bước 1 nếu khác):

```bash
scp <user>@<server>:/workingspace_aiclub/WorkingSpace/Personal/bachdx/AIC2026_Baseline/video_metadata_persistent/video_metadata.json data/meta/
scp <user>@<server>:/workingspace_aiclub/WorkingSpace/Personal/bachdx/AIC2026_Baseline/data/index/ocr_results.json data/meta/
scp <user>@<server>:/home/bachdx/aic_local_data/asr_bge_index/segments.json data/meta/
scp <user>@<server>:/workingspace_aiclub/WorkingSpace/Personal/bachdx/AIC2026_Baseline/faiss_index/frame_ids.json data/meta/
scp <user>@<server>:/workingspace_aiclub/WorkingSpace/Personal/bachdx/AIC2026_Baseline/event_segments_p25.json data/meta/
```

| File trong `data/meta/` (nhận theo tên) | Dùng cho |
|---|---|
| `video_metadata*.json` | FPS — tính số frame / ms khi nộp |
| `*ocr*.json` (vd `ocr_results.json`) | chữ OCR |
| `segments.json` hoặc `*asr*.json` | lời thoại ASR |
| `frame_ids*.json` | dải keyframe — *Chi tiết scene* |
| `event_segments*.json` | dải keyframe — *Chỉ biên scene* |

- Chép file nào dùng file đó. Thiếu file, hoặc video không có trong file → vẫn hỏi backend như cũ.
- Nhiều file cùng loại (vd `ocr_results_batch1.json` + `ocr_results_batch2.json`) được gộp. File OCR tên khác (vd `current_results.json`) thì đổi tên cho có chữ `ocr`.
- File đọc lỗi thì `server.py` báo `!! … LỖI đọc …` và dùng backend cho loại đó. Thay / thêm file lúc đang chạy: tự đọc lại trong ≤ 30 giây.
- Backend cập nhật dữ liệu (OCR mới, thêm batch 2…) thì nhớ chép lại, nếu không trang vẫn dùng bản cũ trên máy.
- `scp` báo *Permission denied* (vd thư mục `/home/bachdx`) → nhờ người chạy backend chép giúp ra chỗ bạn đọc được.
- Tốn RAM khoảng 4 lần dung lượng file (130 MB file ≈ 0,5 GB RAM, đọc ~2 giây khi khởi động).

## Bố cục (giống bản RRF cũ)

- **Thanh bên trái:** tab **KIS · Q&A · TRAKE · ▶ VIDEO** → ô truy vấn → nút **Search** / **DeepSeek** / lọc video đã chọn → **Queries History** (tab *Team* xem truy vấn của đồng đội).
  Tab **▶ VIDEO**: nhập Video ID (+ thời điểm) để mở thẳng video.
- **Mở video bằng ID** (tab ▶ VIDEO, ô mở nhanh trên thanh trên, nút *Mở* của anchor TRAKE): nhận cả batch 1 và batch 2 —
  `L21_V001`, `N051-V001`, `M01_V002`, `S01-V001`; gõ `_` hay `-`, thiếu số 0 (`n51_v1`), có đuôi `.mov/.mp4` đều được.
  Tìm ở máy trước (video có trên máy mở được cả khi **mất kết nối backend**), rồi trên server. Gõ sai → báo **Không tìm thấy** (kèm gợi ý nếu gần giống), không chuyển sang tìm kiếm.
- **Thanh trên:** ● API · đội · ô mở nhanh video · công tắc **Theo video** · **🔑 DRES** · **📤 Xuất** (danh sách nộp) · **✅ Nộp bài**.
- **Mỗi ô kết quả:** **Chọn video** (góc trái) · hạng (góc phải) · khi rê chuột hiện **TRAKE** · **☰** (dải keyframe) · **+** (thêm vào danh sách nộp).
- **Khung preview** (giữ **Alt** + rê chuột, hoặc **Alt+X** để bật luôn): trái = ảnh đang trỏ, phải = frame đang chọn trong dải keyframe.
- **Dải keyframe** (chuột phải lên ảnh): ← → chuyển frame · **↑ Xem lớn / ↓ Ẩn xem** · *Chi tiết scene ↔ Chỉ biên scene* · **=** hoặc **Enter** để thêm.
- **Cửa sổ video** (kéo thanh tiêu đề để di chuyển, đúp chuột về giữa):
  tab **🎯 Frame Calc** — thời điểm (giây), số frame, fps, ô đáp án Q&A, **⊕ Add to Answer**, **✅ Nộp bài frame này**;
  tab **📝 ASR / OCR** — lời thoại / chữ trong video, bấm để tua tới.
- **📤 Xuất:** tab KIS / Q&A / TRAKE, đồng bộ cả đội; nút **CSV** tải file CSV hoặc lưu SOLOAI.
  **Kéo thả** từng dòng để đổi thứ tự (mục #1 / E1 lên đầu); kéo ảnh từ lưới thả vào đúng chỗ muốn chèn.
- **✍ Nộp tay TRAKE** (tab TRAKE, cuối danh sách nộp): gõ Video ID + các frame (`100, 250, 400`), xem trước `TR-…` rồi **✅ Nộp tay**,
  hoặc **＋ Vào danh sách** để thêm các frame đó vào danh sách nộp.
- **Cửa sổ video → Frame Calc → Đến frame** (phím **G**): gõ số frame, Enter → nhảy tới đúng frame đó và dừng.

## Nộp DRES (đúng hướng dẫn BTC)

Bấm **🔑 DRES** → nhập địa chỉ DRES (mặc định `https://eventretrieval.one`) rồi
**Cách 2:** username/password của đội (`POST /api/v2/login`) hoặc **Cách 1:** dán `sessionId` lấy ở `<DRES>/user`.
Danh sách evaluation lấy từ `GET /api/v2/client/evaluation/list?session=…`; nếu chỉ có 1 evaluation ACTIVE thì tự chọn.

Nộp: `POST /api/v2/submit/{evaluationID}?session=<sessionId>` với body:

| Task | answers |
|---|---|
| KIS / VKIS | `{"mediaItemName": "<VIDEO_ID>", "start": <ms>, "end": <ms>}` — **start = end** |
| QA | `{"text": "QA-<ANSWER>-<VIDEO_ID>-<TIME(ms)>"}` |
| TRAKE | `{"text": "TR-<VIDEO_ID>-<FRAME_ID1>,<FRAME_ID2>,..."}` |

- `<ms>` = thời điểm của frame trong video gốc = `frame_id × 1000 / fps` (fps lấy từ `/api/video-fps` của backend).
- Chặn nộp trùng **theo cả đội** (DRES cũng chặn trùng theo đội): danh sách đáp án đã nộp được chia sẻ cho mọi máy qua backend,
  nên đáp án đồng đội đã nộp cũng bị cảnh báo trước khi gửi (“… bởi An”). Chỉ bấm nộp lần nữa trong 6 giây nếu đó là câu truy vấn khác.
- DRES báo *“rejected by filter: Duplicate submission”* → trang hiểu là đội đã nộp đáp án này, gỡ nó khỏi danh sách nộp; bài đó không được chấm lại, không cần nộp tiếp.
- KIS / Q&A: mục đã nộp xong (đúng, sai hay đang chờ chấm) tự gỡ khỏi danh sách nộp của cả team — kể cả khi nộp từ cửa sổ video.
- TRAKE: nộp xong (đúng, sai hay trạng thái khác) thì **dọn sạch danh sách nộp**; nút **↩ Quay lại lần nộp trước** ở dưới cùng lấy lại
  các ứng viên như lúc bấm nộp (mục thêm sau đó vẫn giữ, xếp sau). Nộp trùng / lỗi mạng thì không dọn.
- Cửa sổ DRES có nhật ký các lần nộp gần nhất.
- Chỗ nộp: nút **✅ Nộp bài** (mục #1 trong danh sách, TRAKE = cả chuỗi), nút 🚀 trên từng mục trong 📤 Xuất,
  **✅ Nộp bài frame này** / phím **S** trong cửa sổ video, **Ctrl+S**.

## Phím tắt chính

| Phím | Việc |
|---|---|
| Enter / Ctrl+Enter | Tìm / lọc frame tốt nhất trong các video đã “Chọn video” |
| 1 · 2 · 3 | KIS · Q&A · TRAKE |
| Alt+E · Alt+W · Alt+X | Dịch VI→EN · lưới ↔ theo video · bật/tắt preview |
| Ctrl+Q · Ctrl+E | Reset truy vấn & chế độ · xóa nội dung các ô truy vấn |
| Alt+A · Alt+S · Ctrl+S | Mở/đóng 📤 Xuất · xóa danh sách nộp · nộp mục #1 |
| (video) Space · ←/→ · giữ Shift / Shift+Z · G · C · S · 1–4 | Phát/dừng · lùi/tới 5 giây (từng frame: nút ◀ 1f / 1f ▶) · chạy x1.5 / x2 khi giữ (cả video khi rê chuột lên ảnh) · gõ số frame để nhảy tới · Add to Answer · nộp · tốc độ |

- **Rê chuột** lên ảnh → phát video quanh frame (tắt bằng ▶ Hover) · **Click** → mở video · **Space** → xem ảnh toàn màn hình.
- Ô **✨** trên lưới: tìm chữ OCR / lời thoại ASR trong K kết quả (không phân biệt dấu, nhiều từ cách bằng dấu phẩy).
- Bấm **⚡ AIC 2026** (góc trên trái) để xem toàn bộ phím tắt.
