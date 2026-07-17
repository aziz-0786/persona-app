"use client";
import { useState } from "react";
import { Button, Textarea } from "@/components/ui";
import { Upload, BookOpen, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TabProps } from "./types";

interface IngestedSource {
  label: string;
  chunkCount: number;
}

export function KnowledgeTab({ persona, onNext }: TabProps) {
  const [text, setText] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<IngestedSource[]>([]);

  async function ingest(content: string, label: string): Promise<number | null> {
    setError(null);
    setIngesting(true);
    try {
      const res = await fetch("/api/knowledge/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personaId: persona.id, text: content, source: label }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Ingest failed");
      setSources((prev) => [...prev, { label, chunkCount: data.chunkCount }]);
      return data.chunkCount as number;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ingest failed");
      return null;
    } finally {
      setIngesting(false);
    }
  }

  async function handleAddText() {
    if (!text.trim()) return;
    const count = await ingest(text, "Pasted text");
    if (count !== null) setText("");
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const content = await file.text();
    await ingest(content, file.name);
  }

  const totalChunks = sources.reduce((sum, s) => sum + s.chunkCount, 0);

  return (
    <div className="flex flex-col h-full min-h-[360px]">
      <div className="flex-1 space-y-5">
        <div>
          <h2 className="font-display text-lg font-semibold text-text-primary">Knowledge</h2>
          <p className="text-sm text-text-secondary mt-1">
            Paste text or upload .txt files to give this persona background knowledge. Optional —
            skip if you don&apos;t have any.
          </p>
        </div>

        <Textarea
          label="Paste text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Journal entries, bios, emails — anything that captures how they think or talk..."
          rows={6}
        />

        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            onClick={handleAddText}
            disabled={ingesting || !text.trim()}
          >
            {ingesting ? <Loader2 size={16} className="animate-spin" /> : <BookOpen size={16} />}
            Add text
          </Button>

          <label
            className={cn(
              "inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-xl border border-border bg-elevated hover:bg-border text-text-primary cursor-pointer transition-colors",
              ingesting && "opacity-50 pointer-events-none"
            )}
          >
            <Upload size={16} />
            Upload .txt
            <input
              type="file"
              accept=".txt,text/plain"
              onChange={handleFileUpload}
              className="hidden"
            />
          </label>
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-error/10 border border-error/30 rounded-xl p-3 text-sm text-error">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {sources.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">
              Ingested — {totalChunks} chunk{totalChunks !== 1 ? "s" : ""} total
            </p>
            <ul className="space-y-1.5">
              {sources.map((s, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between text-sm bg-elevated rounded-lg px-3 py-2"
                >
                  <span className="flex items-center gap-2 text-text-secondary truncate">
                    <CheckCircle2 size={14} className="text-success flex-shrink-0" />
                    {s.label}
                  </span>
                  <span className="text-text-muted text-xs flex-shrink-0">
                    {s.chunkCount} chunk{s.chunkCount !== 1 ? "s" : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="flex justify-between items-center pt-4 border-t border-border">
        <span className="text-xs text-text-muted">Optional — you can add more later</span>
        <Button size="sm" onClick={onNext}>
          Next →
        </Button>
      </div>
    </div>
  );
}
