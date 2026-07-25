"use client";

import { useState, useRef } from "react";

export default function TestAvatarPage() {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [status, setStatus] = useState("");
  const [outputUrl, setOutputUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const outputRef = useRef<HTMLVideoElement>(null);

  async function fileToB64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function run() {
    if (!videoFile || !audioFile) {
      setStatus("❌ Select both a .mp4 video and a .wav audio file first");
      return;
    }
    setLoading(true);
    setStatus("⏳ Encoding files…");
    setOutputUrl("");

    try {
      const videoB64 = await fileToB64(videoFile);
      const audioB64 = await fileToB64(audioFile);

      setStatus("⏳ Sending to Duix RunPod endpoint… (cold start ~2-3 min, synthesis ~1-5 min — grab a coffee)");

      const res = await fetch("/api/duix-video-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoB64, audioB64 }),
      });
      const data = await res.json();

      if (data.error) {
        setStatus(`❌ ${data.error}`);
        return;
      }

      // Decode base64 video → blob URL for playback
      const bytes = Uint8Array.from(atob(data.videoB64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      setOutputUrl(url);
      setStatus(`✅ Done! Synthesis took ${data.durationS}s`);
      setTimeout(() => outputRef.current?.play(), 200);
    } catch (e) {
      setStatus(`❌ Network error: ${e}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white p-8 max-w-2xl mx-auto font-sans">
      <h1 className="text-2xl font-bold mb-1">🎭 Duix Avatar — Clone Test</h1>
      <p className="text-gray-400 text-sm mb-8">
        Upload your face video + any WAV audio → get a lip-synced video back.
        Uses the RunPod Duix endpoint (must be deployed and set in .env first).
      </p>

      <div className="space-y-5 mb-6">
        {/* Video input */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Your face video (.mp4)
          </label>
          <p className="text-xs text-gray-500 mb-2">
            10-30s, facing the camera, good lighting. This is your avatar template.
          </p>
          <input
            type="file"
            accept="video/mp4,video/*"
            onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-gray-300
                       file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0
                       file:bg-purple-600 file:text-white hover:file:bg-purple-700 cursor-pointer"
          />
          {videoFile && (
            <p className="text-xs text-green-400 mt-1">
              ✅ {videoFile.name} ({(videoFile.size / 1024 / 1024).toFixed(1)} MB)
            </p>
          )}
        </div>

        {/* Audio input */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Audio file (.wav)
          </label>
          <p className="text-xs text-gray-500 mb-2">
            The voice to lip-sync to. Chatterbox TTS output works directly (24kHz mono WAV).
          </p>
          <input
            type="file"
            accept="audio/wav,audio/*"
            onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-gray-300
                       file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0
                       file:bg-blue-600 file:text-white hover:file:bg-blue-700 cursor-pointer"
          />
          {audioFile && (
            <p className="text-xs text-green-400 mt-1">
              ✅ {audioFile.name} ({(audioFile.size / 1024).toFixed(0)} KB)
            </p>
          )}
        </div>
      </div>

      <button
        onClick={run}
        disabled={loading}
        className="w-full py-3 rounded-xl font-semibold text-white
                   bg-gradient-to-r from-purple-600 to-blue-600
                   hover:from-purple-700 hover:to-blue-700
                   disabled:opacity-50 disabled:cursor-not-allowed
                   active:scale-[0.99] transition-all duration-200"
      >
        {loading ? "⏳ Processing…" : "🚀 Generate Lip-Synced Video"}
      </button>

      {status && (
        <p
          className={`mt-4 text-sm leading-relaxed ${
            status.startsWith("❌")
              ? "text-red-400"
              : status.startsWith("✅")
              ? "text-green-400"
              : "text-yellow-400"
          }`}
        >
          {status}
        </p>
      )}

      {outputUrl && (
        <div className="mt-6">
          <p className="text-sm text-gray-400 mb-2">Output:</p>
          <video
            ref={outputRef}
            src={outputUrl}
            controls
            loop
            playsInline
            className="w-full rounded-xl border border-gray-700"
          />
          <a
            href={outputUrl}
            download="duix-output.mp4"
            className="mt-2 inline-block text-sm text-blue-400 hover:text-blue-300"
          >
            ⬇ Download output.mp4
          </a>
        </div>
      )}

      <div className="mt-10 p-4 rounded-xl bg-gray-900 border border-gray-800 text-xs text-gray-400 space-y-2">
        <p className="font-semibold text-gray-300">What happens when you click Generate</p>
        <ol className="list-decimal list-inside space-y-1">
          <li>Files encoded to base64 in browser</li>
          <li>Sent to /api/duix-video-test (no auth — dev only)</li>
          <li>Forwarded to RunPod Duix endpoint (runsync)</li>
          <li>RunPod boots guiji2025/duix.avatar + starts Flask server (~2-3 min cold)</li>
          <li>face2face synthesis runs (1-5 min depending on video length)</li>
          <li>Output video returned as base64 → played here</li>
        </ol>
        <p className="pt-1 text-gray-500">
          This page is dev-only. The /api/duix-video route (auth-gated) is used for production persona calls.
        </p>
      </div>
    </div>
  );
}
