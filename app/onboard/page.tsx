"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";
import { ShieldCheck, Mic, Square, UserCircle, Upload } from "lucide-react";
import Link from "next/link";
import { arrayBufferToBase64 } from "@/lib/audio";
import { RelationshipSelect } from "@/components/RelationshipSelect";

export default function OnboardPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState<string>("");
  const [checkedConsent, setCheckedConsent] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [consentAudioB64, setConsentAudioB64] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);

  const canContinue = checkedConsent && name.trim().length > 0;

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: "audio/webm" });
        const buffer = await blob.arrayBuffer();
        const b64 = arrayBufferToBase64(buffer);
        setConsentAudioB64(b64);
        stream.getTracks().forEach((t) => t.stop());
      };

      recorder.start();
      setMediaRecorder(recorder);
      setIsRecording(true);
    } catch {
      alert("Microphone access is required to record consent.");
    }
  }

  function stopRecording() {
    mediaRecorder?.stop();
    setIsRecording(false);
    setMediaRecorder(null);
  }

  async function handleConsentFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const b64 = arrayBufferToBase64(buffer);
      setConsentAudioB64(b64);
    } catch {
      alert("Couldn't read that audio file.");
    }
  }

  async function handleContinue() {
    setSaving(true);
    try {
      const res = await fetch("/api/personas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_with_consent",
          name: name.trim(),
          relationship,
          consentVersion: "1.0",
          consentScopeJson: { voiceCloning: true, shareWithOthers: false, persistentStorage: false },
          consentAudioB64,
        }),
      });
      const { personaId } = await res.json();
      router.push(`/create?id=${personaId}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-void flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="flex items-center gap-2 mb-8">
          <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center shadow-glow">
            <span className="text-white text-sm font-bold">P</span>
          </div>
          <span className="font-display font-semibold text-text-primary">Persona</span>
        </div>

        <div className="bg-surface border border-border rounded-2xl p-6 space-y-6">
          {/* Header */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
              <ShieldCheck size={20} className="text-accent" />
            </div>
            <div>
              <h1 className="font-display font-semibold text-text-primary">
                Before we begin
              </h1>
              <p className="text-xs text-text-muted">Consent required</p>
            </div>
          </div>

          {/* Who are you cloning? */}
          <div className="bg-elevated rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <UserCircle size={15} className="text-accent" />
              <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                Who are you cloning?
              </p>
            </div>
            <Input
              label="Name"
              placeholder="e.g. Priya"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
            <RelationshipSelect value={relationship} onChange={setRelationship} />
          </div>

          {/* Explanation */}
          <div className="space-y-3 text-sm text-text-secondary">
            <p>Creating a digital persona involves cloning your voice. Here is what that means:</p>
            <ul className="space-y-2 pl-4">
              {[
                "Your voice recording will be used to generate speech for this persona.",
                "During this demo, your voice sample is not stored after the session ends.",
                "This complies with the ELVIS Act and applicable state voice privacy laws.",
                "You can delete this persona and all associated data at any time.",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <span className="text-accent mt-0.5 flex-shrink-0">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Spoken consent recording */}
          <div className="bg-elevated rounded-xl p-4 space-y-3">
            <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">
              Optional: Record spoken consent
            </p>
            <p className="text-xs text-text-muted">
              Say: &quot;I, [your name], consent to having my voice cloned for this
              digital persona.&quot;
            </p>
            <div className="flex items-center gap-3 flex-wrap">
              {!isRecording ? (
                <button
                  onClick={startRecording}
                  className="flex items-center gap-2 px-3 py-2 bg-accent/10 hover:bg-accent/20 text-accent text-sm rounded-lg transition-colors"
                >
                  <Mic size={14} />
                  Record
                </button>
              ) : (
                <button
                  onClick={stopRecording}
                  className="flex items-center gap-2 px-3 py-2 bg-error/10 hover:bg-error/20 text-error text-sm rounded-lg transition-colors animate-pulse"
                >
                  <Square size={14} />
                  Stop
                </button>
              )}

              <span className="text-xs text-text-muted">or</span>

              <label className="flex items-center gap-2 px-3 py-2 bg-elevated hover:bg-border border border-border text-text-secondary text-sm rounded-lg transition-colors cursor-pointer">
                <Upload size={14} />
                Upload file
                <input
                  type="file"
                  accept=".wav,.mp3,.m4a,.ogg,.webm"
                  onChange={handleConsentFileUpload}
                  className="hidden"
                />
              </label>

              {consentAudioB64 && (
                <span className="text-xs text-success flex items-center gap-1">
                  <span>✓</span> Consent recorded
                </span>
              )}
            </div>
          </div>

          {/* Consent checkbox */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={checkedConsent}
              onChange={(e) => setCheckedConsent(e.target.checked)}
              className="mt-1 w-4 h-4 rounded accent-accent cursor-pointer"
            />
            <span className="text-sm text-text-secondary">
              I understand and consent to voice cloning for this digital persona
            </span>
          </label>

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <Link
              href="/"
              className="flex-1 flex items-center justify-center py-2.5 text-sm font-medium text-text-muted hover:text-text-secondary border border-border hover:border-border rounded-xl transition-colors"
            >
              Cancel
            </Link>
            <Button
              className="flex-1"
              disabled={!canContinue}
              loading={saving}
              onClick={handleContinue}
            >
              Continue →
            </Button>
          </div>
        </div>

        <p className="text-center text-xs text-text-muted mt-4">
          ELVIS Act · CA AB 1836 · IL BIPA
        </p>
      </div>
    </div>
  );
}
