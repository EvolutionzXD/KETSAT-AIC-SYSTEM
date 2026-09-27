# Hướng dẫn nâng cấp Backend & Frontend để load ảnh/video từ Backblaze B2

Tài liệu này ghi chú lại các thay đổi đã thực hiện để chuyển đổi từ việc dùng Token auth 7 ngày (tại Frontend) sang sử dụng Pre-signed URL sinh tự động từ Backend, giúp hệ thống luôn an toàn và không bị giới hạn thời gian.

## 1. Yêu cầu tại Backend (`Final_AIC/backend`)

Để Frontend mới có thể hoạt động, Backend **BẮT BUỘC** phải có những thay đổi sau:

### 1.1 Cài đặt thư viện AWS SDK
Backend cần thư viện `boto3` để tương tác với API của Backblaze B2 (vì B2 hỗ trợ S3-compatible API).
```bash
# Kích hoạt môi trường ảo của backend (nếu có)
pip install boto3
```

### 1.2 Thêm Endpoint tạo Pre-signed URL vào `app.py`
Trong file `backend/app.py`, cần thêm một API endpoint `/api/b2_media/{path:path}`. Endpoint này có nhiệm vụ:
- Tiếp nhận đường dẫn (path) của ảnh/video từ Frontend.
- Dùng `boto3` sinh ra một đường link tạm thời (Pre-signed URL) có giới hạn thời gian (ví dụ: 3600s).
- Redirect (302) trình duyệt của người dùng sang thẳng URL vừa sinh để tải file từ B2.

**Ví dụ cấu hình kết nối B2 trong Backend:**
```python
import boto3
from fastapi.responses import RedirectResponse

# ... Khởi tạo B2 Client ở đầu file app.py ...
try:
    b2_client = boto3.client(
        's3',
        endpoint_url='https://s3.us-east-005.backblazeb2.com',
        aws_access_key_id='8387584b039a',
        aws_secret_access_key='K005WEDHLEl7PXurwZM9L5GrdOvpY3A',
        config=boto3.session.Config(signature_version='s3v4')
    )
except Exception as e:
    b2_client = None

# ... Thêm Endpoint ...
@app.get("/api/b2_media/{path:path}")
def proxy_b2_media(path: str):
    if b2_client is None:
        raise HTTPException(status_code=500, detail="B2 Client not initialized")
    url = b2_client.generate_presigned_url(
        ClientMethod='get_object',
        Params={'Bucket': 'aic2026-cli', 'Key': path},
        ExpiresIn=3600  # 1 hour
    )
    return RedirectResponse(url=url)
```

## 2. Cập nhật tại Frontend (`FE_Final_Clone`)

Frontend sẽ không còn dùng Token tĩnh `Authorization=3_202609...` nữa. Tất cả sẽ gọi qua proxy của Backend.

### 2.1 Lấy Keyframe (Ảnh)
Trong `update_result.js`, hàm `frameImageUrl` được sửa thành:
```javascript
const hashFolder = window.B2_MAPPING[videoId];
const fileName = `${String(frameId).padStart(8, '0')}.jpg`;
const b2Path = `frames/batch1_candidates/${hashFolder}/${fileName}`;
return `${window.BACKEND_BASE || ''}/api/b2_media/${b2Path}`;
```

### 2.2 Lấy Video (Hover Preview)
Trong `update_result.js`, đoạn gán `video.src` trong sự kiện hover (hàm `handleHoverEnter`) được tính toán logic folder `batch1` hoặc `batch2` như sau:
```javascript
const batchDir = result.video_id.startsWith('M') ? 'batch2' : 'batch1';
const b2VideoPath = `videos/${batchDir}/${result.video_id}.mp4`;
video.src = `${window.BACKEND_BASE || ''}/api/b2_media/${b2VideoPath}`;
```

---
**Kết quả**: Frontend sẽ yêu cầu Backend ký URL, Backend ký xong sẽ trả về mã 302, trình duyệt lập tức tải file từ B2 bằng URL an toàn đó. Mọi thứ trong suốt với người dùng.
