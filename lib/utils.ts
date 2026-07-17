import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatRelativeTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

export const EMOTION_EMOJI: Record<string, string> = {
  happy: "😄",
  amused: "😄",
  calm: "😌",
  thinking: "🤔",
  sad: "😔",
  angry: "😤",
  surprised: "😲",
};

export const CHATTERBOX_PRESETS: Record<
  string,
  { exaggeration: number; cfg_weight: number; temperature: number }
> = {
  happy:     { exaggeration: 0.8, cfg_weight: 0.3, temperature: 0.9 },
  amused:    { exaggeration: 0.7, cfg_weight: 0.3, temperature: 0.9 },
  calm:      { exaggeration: 0.3, cfg_weight: 0.5, temperature: 0.7 },
  thinking:  { exaggeration: 0.3, cfg_weight: 0.5, temperature: 0.7 },
  sad:       { exaggeration: 0.4, cfg_weight: 0.6, temperature: 0.6 },
  angry:     { exaggeration: 0.9, cfg_weight: 0.3, temperature: 1.0 },
  surprised: { exaggeration: 0.8, cfg_weight: 0.4, temperature: 0.9 },
  default:   { exaggeration: 0.5, cfg_weight: 0.5, temperature: 0.8 },
};
