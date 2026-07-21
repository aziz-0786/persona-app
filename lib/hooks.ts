"use client";
import { useEffect, useState } from "react";
import type { Persona } from "@/db/schema";

export function usePersona(id: string | undefined | null) {
  const [persona, setPersona] = useState<Persona | null>(null);
  const [loading, setLoading] = useState(!!id);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setPersona(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/personas?id=${id}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load persona");
        return res.json();
      })
      .then((data: Persona) => {
        if (!cancelled) setPersona(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load persona");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  return { persona, loading, error };
}
