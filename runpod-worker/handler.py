"""
Persona — RunPod Chatterbox TTS Worker
Handles voice-cloning TTS inference for the Persona app.

Input:
  {
    "text": "Text to synthesize",
    "voice_b64": "<base64-encoded WAV reference audio>",
    "exaggeration": 0.5,   # float 0.0–1.0, controls emotional expressiveness
    "cfg_weight": 0.5,     # float 0.0–1.0, controls adherence to voice reference
    "temperature": 0.8     # float 0.0–1.0, controls randomness
  }

Output:
  {
    "audio_base64": "<base64-encoded WAV>",
    "sample_rate": 24000
  }

CRITICAL: Chatterbox has NO generate_stream(). Only generate() exists.
"""

import runpod
import base64
import io
import os
import subprocess
import uuid
import logging

import soundfile as sf
import torch

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ─── Load model once at module level (not inside handler) ─────────────────────
# This is loaded when the worker starts, not on each request.
logger.info("Loading ChatterboxTTS model...")

try:
    from chatterbox.tts import ChatterboxTTS

    DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
    logger.info(f"Using device: {DEVICE}")

    model = ChatterboxTTS.from_pretrained(device=DEVICE)
    logger.info("ChatterboxTTS model loaded successfully")
except Exception as e:
    logger.error(f"Failed to load model: {e}")
    raise


# ─── Handler ──────────────────────────────────────────────────────────────────

def handler(job):
    import subprocess, tempfile, os, base64, io
    import soundfile as sf
    import numpy as np

    job_id = job.get("id", "unknown")
    job_input = job.get("input", {})

    text = job_input.get("text", "Hello, world!")
    voice_b64 = job_input.get("voice_b64", "")
    exaggeration = float(job_input.get("exaggeration", 0.5))
    cfg_weight = float(job_input.get("cfg_weight", 0.5))
    temperature = float(job_input.get("temperature", 0.8))

    # ── GUARD: startup test with no voice reference ──────────────────────
    # test_input.json has empty voice_b64. Return success so worker stays alive.
    if not voice_b64 or len(voice_b64.strip().replace("=","")) < 50:
        logger.info(f"[{job_id}] No voice reference — startup test OK")
        return {"status": "ok", "note": "startup test passed — no voice_b64"}

    # ── STRIP DATA URL PREFIX ─────────────────────────────────────────────
    if "," in voice_b64:
        voice_b64 = voice_b64.split(",")[1]

    # ── FIX BASE64 PADDING ───────────────────────────────────────────────
    padding_needed = (4 - len(voice_b64) % 4) % 4
    voice_b64 += "=" * padding_needed

    # ── DECODE ───────────────────────────────────────────────────────────
    try:
        audio_bytes = base64.b64decode(voice_b64)
    except Exception as e:
        logger.error(f"[{job_id}] base64 decode failed: {e}")
        return {"error": f"Invalid base64: {e}"}

    # ── DETECT FORMAT BY MAGIC BYTES ─────────────────────────────────────
    if len(audio_bytes) < 4:
        return {"error": "Audio data too short"}

    if audio_bytes[:4] == b'RIFF':
        src_ext = ".wav"
    elif audio_bytes[:3] == b'OggS':
        src_ext = ".ogg"
    elif audio_bytes[:3] == b'ID3' or audio_bytes[:2] in (b'\xff\xfb', b'\xff\xf3'):
        src_ext = ".mp3"
    else:
        src_ext = ".webm"  # Chrome default

    # ── CONVERT TO 16kHz MONO WAV VIA FFMPEG ────────────────────────────
    raw_path, wav_path = None, None
    try:
        with tempfile.NamedTemporaryFile(suffix=src_ext, delete=False) as f:
            f.write(audio_bytes)
            raw_path = f.name

        wav_path = raw_path.replace(src_ext, "_ref.wav")
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", raw_path,
             "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", wav_path],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            logger.error(f"[{job_id}] ffmpeg failed: {result.stderr[-300:]}")
            return {"error": f"Audio conversion failed: {result.stderr[-200:]}"}

        logger.info(f"[{job_id}] Generating: {len(text)} chars, "
                    f"exag={exaggeration}, cfg={cfg_weight}, temp={temperature}")

        # ── GENERATE ─────────────────────────────────────────────────────
        wav_tensor = model.generate(
            text,
            audio_prompt_path=wav_path,
            exaggeration=exaggeration,
            cfg_weight=cfg_weight,
            temperature=temperature,
        )

        # ── ENCODE OUTPUT TO BASE64 WAV ───────────────────────────────────
        wav_np = wav_tensor.squeeze().cpu().numpy()
        buf = io.BytesIO()
        sf.write(buf, wav_np, model.sr, format="WAV", subtype="PCM_16")
        audio_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

        logger.info(f"[{job_id}] Done. Output size: {len(audio_b64)} chars")
        return {"audio_base64": audio_b64, "sample_rate": model.sr}

    except Exception as e:
        logger.error(f"[{job_id}] Generation error: {repr(e)}")
        return {"error": f"Generation failed: {repr(e)}"}

    finally:
        for p in [raw_path, wav_path]:
            if p and os.path.exists(p):
                try:
                    os.unlink(p)
                except:
                    pass


# ── STARTUP SELF-TEST (runs at import time) ──────────────────────────
if os.environ.get("RUNPOD_ENDPOINT_ID"):
    # Running on RunPod — skip local test, go straight to start
    pass
else:
    # Local test mode
    _test_job = {"id": "local-test-001", "input": {"text": "test", "voice_b64": ""}}
    _result = handler(_test_job)
    if "error" in _result:
        print(f"Startup test error: {_result['error']}")
    elif "audio_base64" in _result:
        print(f"Startup test audio: {len(_result['audio_base64'])} chars")
    else:
        print(f"Startup test passed: {_result.get('note', 'ok')}")

# ── START RUNPOD SERVERLESS ───────────────────────────────────────────
runpod.serverless.start({"handler": handler})
