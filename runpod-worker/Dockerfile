FROM pytorch/pytorch:2.1.2-cuda12.1-cudnn8-devel

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    ffmpeg \
    git \
    && rm -rf /var/lib/apt/lists/*

# Path prefix needed: RunPod build context = repo root, not runpod-worker/
COPY runpod-worker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY runpod-worker/handler.py .
COPY runpod-worker/test_input.json .

CMD ["python", "-u", "handler.py"]