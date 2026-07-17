"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { Mic, Square, Upload, AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { processAudioToWav, type ProcessedAudio } from "@/lib/audio";
import type { TabProps } from "./types";
import { SaveStatus, type SaveState } from "./SaveStatus";

const ACCEPTED_TYPES = ".wav,.mp3,.m4a";

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((c) => MediaRecorder.isTypeSupported?.(c));
}

export function VoiceTab({ persona, patchPersona, onNext }: TabProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [processed, setProcessed] = useState<ProcessedAudio | null>(null);
  const [audioURL, setAudioURL] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>(persona.voiceRefB64 ? "saved" : "idle");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  const cleanupStream = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    analyserRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => cleanupStream, [cleanupStream]);

  function drawWaveform() {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !analyser || !ctx) return;

    const bufferLength = analyser.fftSize;
    const data = new Uint8Array(bufferLength);

    const render = () => {
      if (!analyserRef.current) return;
      rafRef.current = requestAnimationFrame(render);
      analyser.getByteTimeDomainData(data);

      const { width, height } = canvas;
      ctx.fillStyle = "#1E1E32";
      ctx.fillRect(0, 0, width, height);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#6C5FF6";
      ctx.beginPath();

      const slice = width / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = data[i] / 128.0;
        const y = (v * height) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += slice;
      }
      ctx.lineTo(width, height / 2);
      ctx.stroke();
    };
    render();
  }

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AudioCtx();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;
      drawWaveform();

      const recorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = handleRecordingStop;
      recorder.start();
      recorderRef.current = recorder;
      setIsRecording(true);
    } catch {
      setError("Microphone access is required to record.");
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setIsRecording(false);
    cleanupStream();
  }

  async function handleRecordingStop() {
    const blob = new Blob(chunksRef.current, {
      type: (chunksRef.current[0] as Blob)?.type || "audio/webm",
    });
    await ingestClip(blob);
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await ingestClip(file);
  }

  async function ingestClip(blob: Blob) {
    setError(null);
    setProcessing(true);
    try {
      const buf = await blob.arrayBuffer();
      const result = await processAudioToWav(buf);
      setProcessed(result);
      setAudioURL(URL.createObjectURL(blob));

      setSaveState("saving");
      await patchPersona({ voiceRefB64: result.base64 });
      setSaveState("saved");
    } catch (err) {
      console.error(err);
      setError("Couldn't process that audio. Try a clear .wav, .mp3, or .m4a clip.");
      setSaveState("error");
    } finally {
      setProcessing(false);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-[360px]">
      <div className="flex-1 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-semibold text-text-primary">Voice</h2>
            <p className="text-sm text-text-secondary mt-1">
              Record or upload 10–15 seconds of clean speech — this becomes the voice reference.
            </p>
          </div>
          <SaveStatus state={saveState} />
        </div>

        {/* Waveform / playback area */}
        <div className="rounded-xl border border-border overflow-hidden bg-elevated">
          <canvas
            ref={canvasRef}
            width={640}
            height={120}
            className={cn("w-full h-[120px]", !isRecording && "hidden")}
          />
          {!isRecording && audioURL && (
            <div className="p-4">
              <audio controls src={audioURL} className="w-full" />
            </div>
          )}
          {!isRecording && !audioURL && (
            <div className="h-[120px] flex items-center justify-center text-text-muted text-sm">
              {processing ? (
                <span className="flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" /> Processing audio…
                </span>
              ) : (
                "No recording yet"
              )}
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3">
          {!isRecording ? (
            <Button variant="secondary" onClick={startRecording} disabled={processing}>
              <Mic size={16} />
              {audioURL ? "Re-record" : "Record"}
            </Button>
          ) : (
            <Button variant="danger" onClick={stopRecording}>
              <Square size={16} />
              Stop
            </Button>
          )}

          <label
            className={cn(
              "inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-xl border border-border bg-elevated hover:bg-border text-text-primary cursor-pointer transition-colors",
              processing && "opacity-50 pointer-events-none"
            )}
          >
            <Upload size={16} />
            Upload file
            <input
              type="file"
              accept={ACCEPTED_TYPES}
              onChange={handleFileUpload}
              className="hidden"
            />
          </label>

          {processed && (
            <span className="text-xs text-text-muted">
              {processed.durationSec.toFixed(1)}s clip
            </span>
          )}
        </div>

        {processed?.tooNoisy && (
          <div className="flex items-start gap-2 bg-warning/10 border border-warning/30 rounded-xl p-3 text-sm text-warning">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            <span>Too noisy — try somewhere quieter, or move closer to the mic.</span>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 bg-error/10 border border-error/30 rounded-xl p-3 text-sm text-error">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <div className="flex justify-between items-center pt-4 border-t border-border">
        <span className="text-xs text-text-muted">Accepted: .wav .mp3 .m4a, or record live</span>
        <Button size="sm" onClick={onNext}>
          Next →
        </Button>
      </div>
    </div>
  );
}
