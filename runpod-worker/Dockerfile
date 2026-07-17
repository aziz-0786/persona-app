# Persona — Chatterbox TTS RunPod Worker
# Base: RunPod's official PyTorch image (CUDA 12.1, Python 3.11)
FROM runpod/pytorch:2.1.0-py3.11-cuda12.1.1-devel-ubuntu22.04

WORKDIR /app

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    ffmpeg \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY requirements.txt .

# Install Python dependencies
# CRITICAL: transformers==4.46.3 is pinned — Chatterbox requires this exact version
# for its internal Llama backbone. Upgrading breaks it silently.
RUN pip install --no-cache-dir -r requirements.txt

# Copy handler
COPY handler.py .
COPY test_input.json .

# Warm model cache at build time to avoid cold-start model download
# Comment this out if image size is a concern (adds ~3–4 GB)
RUN python -c "from chatterbox.tts import ChatterboxTTS; ChatterboxTTS.from_pretrained(device='cpu')" \
    || echo "Model pre-cache failed — will download at runtime"

CMD ["python", "-u", "handler.py"]
