"use client";
import { useState } from "react";
import { RELATIONSHIP_OPTIONS } from "@/lib/personaFields";

function isKnownOption(value: string): boolean {
  return RELATIONSHIP_OPTIONS.some((o) => o.value === value);
}

export function RelationshipSelect({
  value,
  onChange,
  onBlur,
  label = "Relationship",
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  label?: string;
}) {
  // Sticky "other" mode, tracked separately from `value`: once the user picks
  // "Other", the custom text field starts empty, and an empty `value` alone
  // is indistinguishable from "nothing selected" — deriving mode from value
  // every render snapped the dropdown back to the placeholder mid-typing.
  const [otherMode, setOtherMode] = useState(() => value !== "" && !isKnownOption(value));

  const selectValue = otherMode ? "other" : value;

  function handleSelectChange(next: string) {
    if (next === "other") {
      setOtherMode(true);
      onChange("");
    } else {
      setOtherMode(false);
      onChange(next);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-text-secondary">{label}</label>
      <select
        value={selectValue}
        onChange={(e) => handleSelectChange(e.target.value)}
        onBlur={onBlur}
        className="w-full bg-elevated border border-border rounded-xl px-3.5 py-2.5 text-sm text-text-primary focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50 transition-colors"
      >
        <option value="" disabled>
          Select a relationship
        </option>
        {RELATIONSHIP_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {otherMode && (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder="Describe the relationship (e.g. colleague, idol, character)"
          className="w-full bg-elevated border border-border rounded-xl px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50 transition-colors"
          autoFocus
        />
      )}
    </div>
  );
}
