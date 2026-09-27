#!/bin/bash
set -euo pipefail

IMAGE_NAME="aiclub_backend-bachdx_retrieval_v1"
CONTAINER_NAME="aic_backend_bachdx"
PORT=8602

echo "=========================================="
echo "    🚀 AIC BACKEND DOCKER LAUNCHER 🚀     "
echo "=========================================="

# Bỏ qua bước build vì build lại quá lâu. Mình sẽ xài Image cũ và chắp vá lúc khởi động.

# 2. Dọn dẹp Container cũ nếu bị trùng tên
if docker ps -a --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
    echo "[2/4] Dọn dẹp Container cũ bị trùng tên..."
    docker rm -f "$CONTAINER_NAME"
else
    echo "[2/4] Không có Container cũ nào cản đường."
fi

# 3. Tắt các tiến trình chạy ngầm chiếm cổng (như ./python3)
if lsof -t -i:$PORT > /dev/null 2>&1; then
    echo "[3/4] Phát hiện có tiến trình đang chiếm port $PORT. Đang dọn dẹp..."
    kill -9 $(lsof -t -i:$PORT) || true
    sleep 1
else
    echo "[3/4] Port $PORT đang trống, sẵn sàng cất cánh."
fi

# 4. Khởi động Container
echo "[4/4] Khởi động Container mới..."
docker run --name "$CONTAINER_NAME" \
  --gpus all \
  --ipc=host \
  --network=host \
  -v /workingspace_aiclub:/workingspace_aiclub \
  -v /home/bachdx:/home/bachdx \
  -v /mlcv1:/mlcv1 \
  -w /workingspace_aiclub/WorkingSpace/Personal/bachdx/Final_AIC/backend \
  "$IMAGE_NAME" \
  bash -c 'pip install --no-cache-dir "numpy<2.0.0" "opencv-python<4.9.0" "opencv-python-headless<4.9.0" "timm>=1.0.30" && pip install --no-cache-dir --no-deps "torchscale" && exec python -m uvicorn backend.app:app --host 0.0.0.0 --port 8602 --workers 1'

echo "=========================================="
echo "✅ HOÀN TẤT! Backend đã chạy ngầm trong Docker."
echo "👉 Để xem log trực tiếp, hãy gõ: docker logs -f $CONTAINER_NAME"
echo "=========================================="
