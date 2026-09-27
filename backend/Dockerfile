FROM pytorch/pytorch:2.2.0-cuda12.1-cudnn8-runtime

WORKDIR /app

RUN apt-get update && apt-get install -y \
    ffmpeg \
    libsm6 \
    libxext6 \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-reference.txt .

# Remove faiss-gpu from requirements since it fails to install via pip and conda is broken in this base image
# We will rely on faiss-cpu instead, which is already in the requirements.
RUN sed -i '/faiss-gpu/d' requirements-reference.txt

RUN pip install --no-cache-dir -r requirements-reference.txt

ENV PYTHONPATH=/app
CMD ["python", "-m", "uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8602", "--workers", "1"]
