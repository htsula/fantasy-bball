import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { seasonLabel } from "@/lib/nba/format";

/**
 * "Stats: 2025-26 | 2026-27" toggle for server-rendered pages. The selection lives in `?season=`;
 * the default season is left out of the URL so plain links keep following the default rule.
 */
export function StatsSeasonNav({
  base,
  seasons,
  selected,
  defaultSeason,
  extra = {},
}: {
  base: string;
  /** Offered seasons, newest first. */
  seasons: number[];
  selected: number;
  defaultSeason: number;
  /** Other query params to keep (undefined values are skipped). */
  extra?: Record<string, string | undefined>;
}) {
  const href = (season: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) qs.set(k, v);
    if (season !== defaultSeason) qs.set("season", String(season));
    const s = qs.toString();
    return s ? `${base}?${s}` : base;
  };
  return (
    <nav className="flex flex-wrap items-center gap-1" aria-label="Stats season" data-testid="stats-season-nav">
      <span className="pr-1 text-xs text-muted-foreground">Stats:</span>
      {[...seasons].sort((a, b) => a - b).map((sn) => (
        <Link
          key={sn}
          href={href(sn)}
          aria-current={sn === selected ? "true" : undefined}
          className={buttonVariants({ variant: sn === selected ? "secondary" : "ghost", size: "xs" })}
        >
          {seasonLabel(sn)}
        </Link>
      ))}
    </nav>
  );
}
