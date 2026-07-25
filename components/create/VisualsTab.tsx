"use client";
import { useState } from "react";
import { Button } from "@/components/ui";
import { Check, Upload, AlertTriangle, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TabProps } from "./types";
import { SaveStatus, type SaveState } from "./SaveStatus";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100MB

async function uploadFile(file: File, type: "photo" | "video"): Promise<string> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("type", type);

  const res = await fetch("/api/upload", { method: "POST", body: formData });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error ?? `Upload failed (${res.status})`);
  return data.url as string;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function VisualsTab({ persona, patchPersona, onNext }: TabProps) {
  const [photoUrl, setPhotoUrl] = useState<string | null>(persona.photoUrl ?? null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const [videoUrl, setVideoUrl] = useState<string | null>(persona.videoRefUrl ?? null);
  const [videoName, setVideoName] = useState<string | null>(null);
  const [videoSize, setVideoSize] = useState<number | null>(null);
  const [videoUploading, setVideoUploading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [showTips, setShowTips] = useState(false);

  const [saveState, setSaveState] = useState<SaveState>("idle");

  async function save(updates: { photoUrl?: string; videoRefUrl?: string }) {
    setSaveState("saving");
    try {
      await patchPersona(updates);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  async function handlePhotoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (file.size > MAX_PHOTO_BYTES) {
      setPhotoError("File too large. Max 5MB.");
      return;
    }

    setPhotoError(null);
    setPhotoUploading(true);
    try {
      const url = await uploadFile(file, "photo");
      setPhotoUrl(url);
      await save({ photoUrl: url });
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setPhotoUploading(false);
    }
  }

  async function handleVideoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (file.size > MAX_VIDEO_BYTES) {
      setVideoError("File too large. Max 100MB.");
      return;
    }

    setVideoError(null);
    setVideoUploading(true);
    setVideoName(file.name);
    setVideoSize(file.size);
    try {
      const url = await uploadFile(file, "video");
      setVideoUrl(url);
      await save({ videoRefUrl: url });
    } catch (err) {
      setVideoError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setVideoUploading(false);
    }
  }

  const uploading = photoUploading || videoUploading;

  return (
    <div className="flex flex-col h-full min-h-[360px]">
      <div className="flex-1 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-semibold text-text-primary">
              Visuals (optional)
            </h2>
            <p className="text-sm text-text-secondary mt-1">
              Add a photo and/or video to personalize your experience.
            </p>
          </div>
          <SaveStatus state={saveState} />
        </div>

        {/* Section 1 — Profile Photo */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-text-primary">Profile photo</label>
          <p className="text-xs text-text-muted">
            Used as the background wallpaper during voice calls and in the chat header.
          </p>

          <div className="flex items-center gap-3">
            <label
              className={cn(
                "flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium cursor-pointer transition-colors",
                "border-border text-text-secondary hover:text-text-primary hover:bg-elevated"
              )}
            >
              {photoUploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
              {photoUploading ? "Uploading…" : "Choose photo"}
              <input
                type="file"
                accept="image/*"
                onChange={handlePhotoSelect}
                disabled={photoUploading}
                className="hidden"
              />
            </label>

            {photoUrl && !photoUploading && (
              <div className="flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photoUrl}
                  alt="Profile photo preview"
                  className="w-[100px] h-[100px] rounded-lg object-cover bg-elevated"
                />
                <span className="text-sm text-success flex items-center gap-1">
                  <Check size={14} /> Saved
                </span>
              </div>
            )}
          </div>

          {photoError && (
            <p className="text-sm text-error">
              {photoError} <span className="text-text-muted">— you can try again.</span>
            </p>
          )}
        </div>

        {/* Section 2 — Video for AI Video Avatar */}
        <div className="space-y-2 pt-2 border-t border-border">
          <label className="text-sm font-medium text-text-primary pt-4 block">
            Video for AI video avatar
          </label>
          <p className="text-xs text-text-muted">
            Record or upload a short video of yourself looking directly at the camera.
            This enables a realistic AI video avatar that animates and speaks in your likeness.
          </p>

          <div className="flex items-start gap-2 border border-warning/30 bg-warning/10 rounded-lg p-3">
            <AlertTriangle size={15} className="text-warning flex-shrink-0 mt-0.5" />
            <p className="text-xs text-text-secondary">
              <span className="font-medium text-warning">Video required for the video avatar feature.</span>{" "}
              Without this video, the persona will display a photo wallpaper during calls instead.
              You can always record and add this later by editing the persona.
            </p>
          </div>

          <button
            type="button"
            onClick={() => setShowTips((v) => !v)}
            className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
          >
            <ChevronDown size={13} className={cn("transition-transform", showTips && "rotate-180")} />
            {showTips ? "Hide tips" : "Show tips"}
          </button>
          {showTips && (
            <ul className="text-xs text-text-muted list-disc list-inside space-y-1 pl-1">
              <li>Face the camera directly in good lighting</li>
              <li>Speak naturally for 10–30 seconds — say anything</li>
              <li>Avoid background noise and sudden movements</li>
              <li>720p or higher, MP4 format preferred</li>
            </ul>
          )}

          <div className="flex items-center gap-3 pt-1">
            <label
              className={cn(
                "flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium cursor-pointer transition-colors",
                "border-border text-text-secondary hover:text-text-primary hover:bg-elevated"
              )}
            >
              {videoUploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
              {videoUploading ? "Uploading video…" : "Choose video"}
              <input
                type="file"
                accept="video/mp4,video/*"
                onChange={handleVideoSelect}
                disabled={videoUploading}
                className="hidden"
              />
            </label>
          </div>

          {videoUploading && (
            <div className="space-y-1">
              <div className="h-1.5 w-full bg-elevated rounded-full overflow-hidden">
                <div className="h-full w-1/3 bg-accent rounded-full animate-[pulse_1.2s_ease-in-out_infinite]" />
              </div>
              {videoName && <p className="text-xs text-text-muted">{videoName}</p>}
            </div>
          )}

          {videoUrl && !videoUploading && (
            <div className="flex items-center gap-2 text-sm text-success">
              <Check size={14} />
              <span>
                Video saved. Video avatar enabled.
                {videoName && (
                  <span className="text-text-muted">
                    {" "}
                    ({videoName}
                    {videoSize ? `, ${formatBytes(videoSize)}` : ""})
                  </span>
                )}
              </span>
            </div>
          )}

          {videoError && (
            <p className="text-sm text-error">
              {videoError} <span className="text-text-muted">— you can try again.</span>
            </p>
          )}
        </div>
      </div>

      <div className="flex justify-between items-center pt-4 border-t border-border">
        <span className="text-xs text-text-muted">Both are optional — you can skip this step</span>
        <Button size="sm" onClick={onNext} disabled={uploading}>
          Next →
        </Button>
      </div>
    </div>
  );
}
