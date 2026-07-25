"use client";
import { useRef, useState } from "react";
import { Button } from "@/components/ui";
import { Check, Upload, AlertTriangle, ChevronDown, Loader2, X, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { compressImage, convertGDriveUrl } from "@/lib/imageUtils";
import type { TabProps } from "./types";
import { SaveStatus, type SaveState } from "./SaveStatus";

const MAX_PHOTO_RAW_BYTES = 10 * 1024 * 1024; // 10MB raw upload, compressed down after

type PhotoStatus = "idle" | "compressing" | "error";
type VideoStatus = "idle" | "valid" | "error";

export function VisualsTab({ persona, patchPersona, onNext }: TabProps) {
  const [photoPreview, setPhotoPreview] = useState<string | null>(persona.photoUrl ?? null);
  const [photoStatus, setPhotoStatus] = useState<PhotoStatus>("idle");
  const [photoErrorMsg, setPhotoErrorMsg] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const [videoUrl, setVideoUrl] = useState(persona.videoRefUrl ?? "");
  const [videoStatus, setVideoStatus] = useState<VideoStatus>(persona.videoRefUrl ? "valid" : "idle");
  const [gdriveDetected, setGdriveDetected] = useState(false);
  const [showGDriveHelp, setShowGDriveHelp] = useState(false);
  // The URL actually PATCHed to the DB — the converted uc?export= link for
  // Drive shares, the raw pasted value for everything else.
  const savedVideoUrlRef = useRef(persona.videoRefUrl ?? "");

  const [saveState, setSaveState] = useState<SaveState>("idle");

  async function save(updates: { photoUrl?: string | null; videoRefUrl?: string | null }) {
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

    if (file.size > MAX_PHOTO_RAW_BYTES) {
      setPhotoStatus("error");
      setPhotoErrorMsg("File too large (max 10MB)");
      return;
    }

    setPhotoErrorMsg(null);
    setPhotoStatus("compressing");
    try {
      const dataUrl = await compressImage(file);
      setPhotoPreview(dataUrl);
      setPhotoStatus("idle");
      await save({ photoUrl: dataUrl });
    } catch (err) {
      setPhotoStatus("error");
      setPhotoErrorMsg(err instanceof Error ? err.message : "Couldn't process that image");
    }
  }

  async function handlePhotoRemove() {
    setPhotoPreview(null);
    setPhotoStatus("idle");
    setPhotoErrorMsg(null);
    await save({ photoUrl: null });
  }

  function handleVideoInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    setVideoUrl(raw);

    if (!raw.trim()) {
      setVideoStatus("idle");
      setGdriveDetected(false);
      return;
    }

    const converted = convertGDriveUrl(raw.trim());
    if (converted) {
      setGdriveDetected(true);
      setVideoStatus("valid");
      return;
    }

    setGdriveDetected(false);
    setVideoStatus(raw.trim().startsWith("https://") ? "valid" : "error");
  }

  async function handleVideoBlur() {
    const trimmed = videoUrl.trim();

    if (!trimmed) {
      if (savedVideoUrlRef.current) {
        savedVideoUrlRef.current = "";
        await save({ videoRefUrl: null });
      }
      return;
    }

    const converted = convertGDriveUrl(trimmed);
    const effectiveUrl = converted ?? trimmed;

    if (!converted && !trimmed.startsWith("https://")) {
      setVideoStatus("error");
      return;
    }

    if (effectiveUrl === savedVideoUrlRef.current) return;
    savedVideoUrlRef.current = effectiveUrl;
    await save({ videoRefUrl: effectiveUrl });
  }

  async function handleVideoRemove() {
    setVideoUrl("");
    setVideoStatus("idle");
    setGdriveDetected(false);
    savedVideoUrlRef.current = "";
    await save({ videoRefUrl: null });
  }

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

        {/* Photo section */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-text-primary">Profile photo (optional)</label>
          <p className="text-xs text-text-muted">
            Shown as the background wallpaper during voice calls and in the chat header.
          </p>

          {!photoPreview ? (
            <label
              className={cn(
                "inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium cursor-pointer transition-colors",
                "border-border text-text-secondary hover:text-text-primary hover:bg-elevated"
              )}
            >
              {photoStatus === "compressing" ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Upload size={15} />
              )}
              {photoStatus === "compressing" ? "Compressing…" : "Choose photo"}
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                onChange={handlePhotoSelect}
                disabled={photoStatus === "compressing"}
                className="hidden"
              />
            </label>
          ) : (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photoPreview}
                alt="Profile photo preview"
                className="w-20 h-20 rounded-full object-cover border border-border"
              />
              <div className="flex flex-col gap-1.5">
                <button
                  type="button"
                  onClick={handlePhotoRemove}
                  className="flex items-center gap-1.5 text-xs text-error hover:underline w-fit"
                >
                  <X size={12} /> Remove
                </button>
                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary w-fit"
                >
                  <RefreshCw size={12} /> Replace
                  <input
                    ref={photoInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handlePhotoSelect}
                    className="hidden"
                  />
                </button>
              </div>
            </div>
          )}

          {photoStatus === "error" && photoErrorMsg && (
            <p className="text-sm text-error">{photoErrorMsg}</p>
          )}
        </div>

        {/* Video section */}
        <div className="space-y-2 pt-2 border-t border-border">
          <label className="text-sm font-medium text-text-primary pt-4 block">
            Video for AI video avatar (optional)
          </label>
          <p className="text-xs text-text-muted">
            A 10–30 second video of yourself looking at the camera. Powers the lip-synced AI
            video avatar. You can skip this and add it later.
          </p>

          <div className="flex items-start gap-2 border border-warning/30 bg-warning/10 rounded-lg p-3">
            <AlertTriangle size={15} className="text-warning flex-shrink-0 mt-0.5" />
            <p className="text-xs text-text-secondary">
              <span className="font-medium text-warning">Video required for the video avatar feature.</span>{" "}
              Without this video, the persona will use a photo wallpaper during calls instead.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={videoUrl}
              onChange={handleVideoInputChange}
              onBlur={handleVideoBlur}
              placeholder="Paste a public video URL (Google Drive, Dropbox, etc.)"
              className={cn(
                "flex-1 bg-elevated border rounded-xl px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-muted",
                "focus:outline-none focus:ring-1 transition-colors",
                videoStatus === "error"
                  ? "border-error focus:border-error focus:ring-error/50"
                  : "border-border focus:border-accent focus:ring-accent/50"
              )}
            />
            {videoUrl && (
              <button
                type="button"
                onClick={handleVideoRemove}
                className="text-xs text-error hover:underline flex-shrink-0"
              >
                Remove video
              </button>
            )}
          </div>

          {gdriveDetected && (
            <p className="text-xs text-success flex items-center gap-1">
              <Check size={12} /> Google Drive link detected — converted to direct download URL
            </p>
          )}
          {!gdriveDetected && videoStatus === "valid" && (
            <p className="text-xs text-success flex items-center gap-1">
              <Check size={12} /> URL saved
            </p>
          )}
          {videoStatus === "error" && (
            <p className="text-xs text-error">URL must start with https://</p>
          )}

          <button
            type="button"
            onClick={() => setShowGDriveHelp((v) => !v)}
            className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
          >
            <ChevronDown size={13} className={cn("transition-transform", showGDriveHelp && "rotate-180")} />
            Using Google Drive? Convert your sharing link →
          </button>
          {showGDriveHelp && (
            <ol className="text-xs text-text-muted list-decimal list-inside space-y-1 pl-1">
              <li>Upload your video to Google Drive</li>
              <li>Right-click the file → Share → &quot;Anyone with the link can view&quot;</li>
              <li>Copy the sharing link and paste it above — we&apos;ll convert it automatically</li>
            </ol>
          )}
        </div>
      </div>

      <div className="flex justify-between items-center pt-4 border-t border-border">
        <span className="text-xs text-text-muted">Both are optional — you can skip this step</span>
        <Button size="sm" onClick={onNext}>
          Next →
        </Button>
      </div>
    </div>
  );
}
