import { Badge } from "@/components/ui/badge";

const SHORT: Record<string, string> = {
  out: "OUT",
  "out for season": "OFS",
  "day-to-day": "DTD",
  questionable: "Q",
  doubtful: "D",
  probable: "P",
  suspension: "SUSP",
};

/** Compact injury status badge; renders nothing for healthy players. */
export function InjuryBadge({ status, detail }: { status: string | null | undefined; detail?: string | null }) {
  if (!status) return null;
  const key = status.toLowerCase();
  const severe = key.startsWith("out") || key === "suspension";
  return (
    <Badge variant={severe ? "destructive" : "secondary"} title={detail ? `${status}: ${detail}` : status}>
      {SHORT[key] ?? status}
    </Badge>
  );
}
