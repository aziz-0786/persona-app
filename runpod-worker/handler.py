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

def handler(job: dict) -> dict:
    """
    RunPod serverless handler. Called once per inference request.
    """
    job_id = job.get("id", str(uuid.uuid4()))
    inp = job.get("input", {})

    text = inp.get("text", "").strip()
    voice_b64 = inp.get("voice_b64", "")
    exaggeration = float(inp.get("exaggeration", 0.5))
    cfg_weight = float(inp.get("cfg_weight", 0.5))
    temperature = float(inp.get("temperature", 0.8))

    if not text:
        return {"error": "No text provided"}
    if not voice_b64:
        return {"error": "No voice_b64 provided"}

    # Clamp params to valid ranges
    exaggeration = max(0.0, min(1.0, exaggeration))
    cfg_weight = max(0.0, min(1.0, cfg_weight))
    temperature = max(0.1, min(1.5, temperature))

    # Write voice reference to a temp file
    ref_path = f"/tmp/ref_{job_id}.wav"
    try:
        ref_bytes = base64.b64decode(voice_b64)
        with open(ref_path, "wb") as f:
            f.write(ref_bytes)

        logger.info(
            f"[{job_id}] Generating: {len(text)} chars, "
            f"exag={exaggeration}, cfg={cfg_weight}, temp={temperature}"
        )

        # ONLY generate() — no generate_stream() exists in Chatterbox
        wav = model.generate(
            text=text,
            audio_prompt_path=ref_path,
            exaggeration=exaggeration,
            cfg_weight=cfg_weight,
            temperature=temperature,
        )

        # Convert tensor to WAV bytes
        wav_np = wav.squeeze().cpu().numpy()
        buf = io.BytesIO()
        sf.write(buf, wav_np, samplerate=24000, format="WAV")
        buf.seek(0)
        audio_b64 = base64.b64encode(buf.read()).decode("utf-8")

        logger.info(f"[{job_id}] Done — output {len(audio_b64)} b64 chars")
        return {"audio_base64": audio_b64, "sample_rate": 24000}

    except Exception as e:
        logger.error(f"[{job_id}] Generation error: {e}")
        return {"error": str(e)}

    finally:
        # Always clean up the temp file
        if os.path.exists(ref_path):
            os.remove(ref_path)


# ─── Local test ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    """
    Test locally before deploying.
    Usage: python handler.py
    Requires: test_input.json in the same directory
    """
    import json

    with open(os.path.join(os.path.dirname(__file__), "test_input.json")) as f:
        test_job = json.load(f)

    test_job["id"] = "local-test-001"
    result = handler(test_job)

    if "error" in result:
        print(f"ERROR: {result['error']}")
    else:
        # Write output WAV for listening
        out_bytes = base64.b64decode(result["audio_base64"])
        with open("/tmp/test_output.wav", "wb") as f:
            f.write(out_bytes)
        print(f"SUCCESS — output written to /tmp/test_output.wav")
        print(f"Sample rate: {result['sample_rate']} Hz")

else:
    # Production entry point — RunPod calls this
    runpod.serverless.start({"handler": handler})
