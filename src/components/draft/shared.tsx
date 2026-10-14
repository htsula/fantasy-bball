"use client";

import { useEffect, useState } from "react";
import type { DraftFormat } from "@/lib/draft/board";

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as T;
}

export function formatElapsed(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60_000);
  if (mins < 1) return "less than a minute";
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** "3h 12m" since an ISO time; rendered after mount so server and client markup match. */
export function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return <span suppressHydrationWarning>{now === null ? "..." : formatElapsed(now - new Date(since).getTime())}</span>;
}

export function waveBreakdown(f: Pick<DraftFormat, "waveCount" | "fullWaves" | "waveSize" | "lastWaveSize">): string {
  if (f.waveCount === 0) return "None, the whole draft is snake";
  if (f.fullWaves === 0) return `1 wave of ${f.lastWaveSize}`;
  if (f.fullWaves < f.waveCount) {
    return `${f.fullWaves} ${f.fullWaves === 1 ? "wave" : "waves"} of ${f.waveSize}, then a final wave of ${f.lastWaveSize}`;
  }
  return `${f.waveCount} ${f.waveCount === 1 ? "wave" : "waves"} of ${f.waveSize}`;
}
