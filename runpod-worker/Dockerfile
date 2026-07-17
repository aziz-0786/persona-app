FROM pytorch/pytorch:2.1.2-cuda12.1-cudnn8-devel

WORKDIR /app

# Prevent tzdata and other packages from asking interactive questions
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    ffmpeg \
    git \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY runpod-worker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY runpod-worker/handler.py .
COPY runpod-worker/test_input.json .

CMD ["python", "-u", "handler.py"]