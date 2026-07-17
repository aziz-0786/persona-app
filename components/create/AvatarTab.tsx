"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { Upload, Check, User } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TabProps } from "./types";
import { SaveStatus, type SaveState } from "./SaveStatus";

type Option = "avaturn" | "upload" | "default";

const AVATURN_PROJECT = process.env.NEXT_PUBLIC_AVATURN_PROJECT;

const OPTIONS: { id: Option; label: string }[] = [
  { id: "avaturn", label: "Avaturn" },
  { id: "upload", label: "Upload" },
  { id: "default", label: "Default" },
];

interface AvaturnExportPayload {
  eventName?: string;
  type?: string;
  data?: { url?: string };
  url?: string;
}

function parseAvaturnMessage(raw: unknown): AvaturnExportPayload | null {
  let data = raw;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  return data && typeof data === "object" ? (data as AvaturnExportPayload) : null;
}

export function AvatarTab({ persona, patchPersona, onNext }: TabProps) {
  const [option, setOption] = useState<Option>((persona.avatarType as Option) || "avaturn");
  const [previewUrl, setPreviewUrl] = useState<string | null>(persona.avatarUrl ?? null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  async function save(updates: { avatarUrl: string | null; avatarType: Option }) {
    setSaveState("saving");
    try {
      await patchPersona(updates);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (!AVATURN_PROJECT || !event.origin.includes("avaturn")) return;

      const payload = parseAvaturnMessage(event.data);
      if (!payload) return;

      const eventName = payload.eventName ?? payload.type;
      const url = payload.data?.url ?? payload.url;

      if ((eventName === "v2.avatar.exported" || eventName === "avaturn:export") && url) {
        setPreviewUrl(url);
        setOption("avaturn");
        save({ avatarUrl: url, avatarType: "avaturn" });
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
    // Runs once — `save` only closes over stable setState fns and patchPersona
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectOption(next: Option) {
    setOption(next);
    if (next === "default") {
      setPreviewUrl(null);
      save({ avatarUrl: null, avatarType: "default" });
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "glb" && ext !== "vrm") {
      setError("Please upload a .glb or .vrm file.");
      return;
    }

    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setPreviewUrl(dataUrl);
      save({ avatarUrl: dataUrl, avatarType: "upload" });
    };
    reader.onerror = () => setError("Couldn't read that file.");
    reader.readAsDataURL(file);
  }

  return (
    <div className="flex flex-col h-full min-h-[360px]">
      <div className="flex-1 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-semibold text-text-primary">Avatar</h2>
            <p className="text-sm text-text-secondary mt-1">
              Create a realistic 3D avatar with Avaturn, upload your own, or use the default.
            </p>
          </div>
          <SaveStatus state={saveState} />
        </div>

        <div className="grid grid-cols-3 gap-2">
          {OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => selectOption(opt.id)}
              className={cn(
                "flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-colors",
                option === opt.id
                  ? "bg-accent/10 border-accent text-accent"
                  : "border-border text-text-secondary hover:text-text-primary hover:bg-elevated"
              )}
            >
              {option === opt.id && <Check size={14} />}
              {opt.label}
            </button>
          ))}
        </div>

        {option === "avaturn" && (
          <div className="space-y-3">
            {AVATURN_PROJECT ? (
              <div className="rounded-xl overflow-hidden border border-border" style={{ height: 480 }}>
                <iframe
                  src={`https://${AVATURN_PROJECT}.avaturn.dev/`}
                  allow="camera"
                  className="w-full h-full"
                  title="Avaturn avatar creator"
                />
              </div>
            ) : (
              <div className="bg-elevated rounded-xl p-4 text-sm text-text-muted">
                Set NEXT_PUBLIC_AVATURN_PROJECT to enable the Avaturn creator.
              </div>
            )}
            {previewUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <div className="flex items-center gap-3 bg-elevated rounded-xl p-3">
                <img
                  src={previewUrl}
                  alt="Avatar preview"
                  className="w-16 h-16 rounded-lg object-cover bg-void"
                />
                <span className="text-sm text-success flex items-center gap-1">
                  <Check size={14} /> Avatar exported
                </span>
              </div>
            )}
          </div>
        )}

        {option === "upload" && (
          <div className="space-y-3">
            <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-border hover:border-accent/50 rounded-xl py-10 cursor-pointer transition-colors text-text-muted hover:text-accent">
              <Upload size={24} />
              <span className="text-sm font-medium">Upload .glb or .vrm</span>
              <input type="file" accept=".glb,.vrm" onChange={handleFileUpload} className="hidden" />
            </label>
            {previewUrl && (
              <div className="flex items-center gap-2 text-sm text-success">
                <Check size={14} /> File uploaded
              </div>
            )}
          </div>
        )}

        {option === "default" && (
          <div className="flex flex-col items-center justify-center gap-3 bg-elevated rounded-xl py-10">
            <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center">
              <User size={28} className="text-accent" />
            </div>
            <p className="text-sm text-text-secondary">Using the default bundled avatar</p>
          </div>
        )}

        {error && <p className="text-sm text-error">{error}</p>}
      </div>

      <div className="flex justify-between items-center pt-4 border-t border-border">
        <span className="text-xs text-text-muted">You can change this anytime</span>
        <Button size="sm" onClick={onNext}>
          Next →
        </Button>
      </div>
    </div>
  );
}
