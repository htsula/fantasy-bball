"use client";

import { useEffect, useState } from "react";

function format(ms: number): string {
  if (ms <= 0) return "ending now";
  const mins = Math.floor(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

/** Time remaining until `endsAt` (ISO string). Renders the exact time first so SSR and client agree. */
export function Countdown({ endsAt, label }: { endsAt: string; label: string }) {
  const [left, setLeft] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setLeft(format(new Date(endsAt).getTime() - Date.now()));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [endsAt]);
  return (
    <span data-testid="countdown" suppressHydrationWarning>
      {label}
      {left ? ` (${left})` : ""}
    </span>
  );
}
