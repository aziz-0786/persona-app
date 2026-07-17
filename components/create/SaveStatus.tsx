import { Check, Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export type SaveState = "idle" | "saving" | "saved" | "error";

export function SaveStatus({ state, className }: { state: SaveState; className?: string }) {
  if (state === "idle") return null;

  return (
    <span
      className={cn(
        "text-xs flex items-center gap-1",
        state === "saving" && "text-text-muted",
        state === "saved" && "text-success",
        state === "error" && "text-error",
        className
      )}
    >
      {state === "saving" && (
        <>
          <Loader2 size={12} className="animate-spin" /> Saving…
        </>
      )}
      {state === "saved" && (
        <>
          <Check size={12} /> Saved
        </>
      )}
      {state === "error" && (
        <>
          <AlertTriangle size={12} /> Failed to save
        </>
      )}
    </span>
  );
}
