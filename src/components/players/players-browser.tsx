/**
 * Shared Players table: filters, sortable stat columns and pagination. Used by the global NBA
 * browser (/players) and the league-scoped free agency page. Server component (GET forms + links).
 */
import Link from "next/link";
import { db } from "@/db";
import { InjuryBadge } from "@/components/nba/injury-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { SortSelect } from "@/components/players/sort-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtNum, fmtPct, seasonLabel } from "@/lib/nba/format";
import { parsePlayerParams, playerParamsSchema, type PlayerParams } from "@/lib/nba/player-params";
import {
  OWNERSHIP_FILTERS,
  RANGES,
  type OwnershipFilter,
  type SortKey,
  listFilterOptions,
  listPlayers,
} from "@/lib/nba/players-query";

export { parsePlayerParams, playerParamsSchema, type PlayerParams };

const RANGE_LABELS: Record<(typeof RANGES)[number], string> = {
  season: "Range: Full season",
  "7": "Range: Last 7 days",
  "15": "Range: Last 15 days",
  "30": "Range: Last 30 days",
};

const OWNERSHIP_LABELS: Record<OwnershipFilter, string> = { fa: "Free agents", rostered: "Rostered", all: "All" };

const COLUMNS: { key: SortKey; label: string; title?: string }[] = [
  { key: "gp", label: "GP" },
  { key: "min", label: "MIN" },
  { key: "pts", label: "PTS" },
  { key: "reb", label: "REB" },
  { key: "ast", label: "AST" },
  { key: "stl", label: "STL" },
  { key: "blk", label: "BLK" },
  { key: "to", label: "TO" },
  { key: "tpm", label: "3PM" },
  { key: "fgpct", label: "FG%" },
  { key: "ftpct", label: "FT%" },
  { key: "fpavg", label: "FP/G", title: "Fantasy points per game, including the +4 team-win bonus" },
  { key: "proj", label: "Proj" },
  { key: "fptotal", label: "FP", title: "Total fantasy points, including the +4 team-win bonus (approximated for past games)" },
];

type Row = Awaited<ReturnType<typeof listPlayers>>["rows"][number];

export async function PlayersBrowser({
  basePath,
  params,
  league,
  renderAction,
  isAdmin = false,
}: {
  basePath: string;
  params: PlayerParams;
  /** Set for the league-scoped page: adds the ownership filter and an Owner column. */
  league?: { id: string };
  /** League mode: the Add button (or similar) for a row. */
  renderAction?: (row: Row) => React.ReactNode;
  /** Site admins get a hint on how to load missing stats. */
  isAdmin?: boolean;
}) {
  const [result, options] = await Promise.all([
    listPlayers(db, {
      ...params,
      healthy: params.healthy === "1",
      league: league ? { id: league.id, status: params.status } : undefined,
    }),
    listFilterOptions(db),
  ]);

  const href = (over: Partial<Record<string, string | number | undefined>>) => {
    const next: Record<string, string | number | undefined> = {
      q: params.q, team: params.team, inj: params.inj, healthy: params.healthy,
      range: result.range === "season" ? undefined : result.range,
      season: params.season,
      sort: params.sort === "fptotal" ? undefined : params.sort,
      dir: params.dir === "desc" ? undefined : params.dir,
      status: league && params.status !== "fa" ? params.status : undefined,
      page: undefined,
      ...over,
    };
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const s = qs.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  const sortHref = (key: SortKey) =>
    href({ sort: key, dir: params.sort === key ? (params.dir === "desc" ? "asc" : "desc") : key === "name" || key === "to" ? "asc" : "desc" });
  const mobileValue = (r: Row): string => {
  switch (params.sort) {
    case "gp": return String(r.gp);
    case "min": return fmtNum(r.min);
    case "pts": return fmtNum(r.pts);
    case "reb": return fmtNum(r.reb);
    case "ast": return fmtNum(r.ast);
    case "stl": return fmtNum(r.stl);
    case "blk": return fmtNum(r.blk);
    case "to": return fmtNum(r.to);
    case "tpm": return fmtNum(r.tpm);
    case "fgpct": return fmtPct(r.fgPct);
    case "ftpct": return fmtPct(r.ftPct);
    case "proj": return fmtNum(r.proj);
    case "fptotal": return fmtNum(r.fpTotal, 0);
    default: return fmtNum(r.fpAvg);
  }
};
  const mobileLabel = params.sort === "name" ? "FP/G" : (COLUMNS.find((c) => c.key === params.sort)?.label ?? "FP/G");
  const sortOptions = [
    ...COLUMNS.map((c) => ({ key: c.key as string, label: `Sort: ${c.label}`, href: href({ sort: c.key, dir: c.key === "to" ? "asc" : "desc" }) })),
    { key: "name", label: "Sort: Name", href: href({ sort: "name", dir: "asc" }) },
  ];
  const extraCols = (league ? 1 : 0) + (renderAction ? 1 : 0);

  return (
    <div className="grid gap-4">
      {!result.seasonHasData && (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground" data-testid="no-stats">
          No {seasonLabel(result.season)} stats loaded yet.
          {isAdmin && (
            <>
              {" "}
              Admin: run <code className="rounded bg-muted px-1">npm run sync:daily -- --season {result.season}</code> once, or Admin → Data sync.
            </>
          )}
        </p>
      )}
      <SortSelect value={params.sort} options={sortOptions} />
      <form method="get" action={basePath} className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6" aria-label="Player filters">
        <Input name="q" defaultValue={params.q} placeholder="Search name" aria-label="Search name" className="sm:col-span-3 lg:col-span-2" />
        {league && (
          <NativeSelect name="status" defaultValue={params.status} aria-label="Status">
            {OWNERSHIP_FILTERS.map((s) => (
              <option key={s} value={s}>
                Status: {OWNERSHIP_LABELS[s]}
              </option>
            ))}
          </NativeSelect>
        )}
        <NativeSelect name="team" defaultValue={params.team ?? ""} aria-label="NBA team">
          <option value="">All teams</option>
          {options.teams.map((t) => (
            <option key={t.id} value={t.id}>{t.abbrev}</option>
          ))}
        </NativeSelect>
        <NativeSelect name="inj" defaultValue={params.inj ?? ""} aria-label="Injury status">
          <option value="">Any injury status</option>
          {options.injuryStatuses.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </NativeSelect>
        <NativeSelect name="season" defaultValue={result.season} aria-label="Season">
          {result.seasons.map((sn) => (
            <option key={sn} value={sn}>
              Season: {seasonLabel(sn)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          name="range"
          defaultValue={result.range}
          disabled={result.rangeLocked}
          aria-label="Time range"
          title={result.rangeLocked ? "7/15/30-day ranges only apply to the current season" : undefined}
        >
          {RANGES.map((r) => (
            <option key={r} value={r}>{RANGE_LABELS[r]}</option>
          ))}
        </NativeSelect>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="healthy" value="1" defaultChecked={params.healthy === "1"} className="size-4" />
          Healthy only
        </label>
        <input type="hidden" name="sort" value={params.sort} />
        <input type="hidden" name="dir" value={params.dir} />
        <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
          <Button type="submit" size="sm">Apply</Button>
          <Link href={basePath} className={buttonVariants({ variant: "outline", size: "sm" })}>Reset</Link>
        </div>
      </form>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sm:sticky sm:left-0 sm:z-10 sm:bg-background">
                <Link href={sortHref("name")} className="underline-offset-4 hover:underline">
                  Player{params.sort === "name" ? (params.dir === "asc" ? " ▲" : " ▼") : ""}
                </Link>
              </TableHead>
              <TableHead className="text-right sm:hidden">{mobileLabel}</TableHead>
              {renderAction && <TableHead className="w-px"><span className="sr-only">Action</span></TableHead>}
              <TableHead className="hidden sm:table-cell">Team</TableHead>
              {league && <TableHead className="hidden sm:table-cell">Fantasy team</TableHead>}
              <TableHead className="hidden sm:table-cell">Pos</TableHead>
              {COLUMNS.map((c) => (
                <TableHead key={c.key} className="hidden text-right sm:table-cell">
                  <Link href={sortHref(c.key)} title={c.title} className="underline-offset-4 hover:underline">
                    {c.label}
                    {params.sort === c.key ? (params.dir === "asc" ? " ▲" : " ▼") : ""}
                  </Link>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={3 + COLUMNS.length + extraCols} className="text-muted-foreground">
                  No players match. {result.total === 0 && !league && "Run a data sync from the Admin page to load players."}
                </TableCell>
              </TableRow>
            )}
            {result.rows.map((r) => (
              <TableRow key={r.id} data-testid="player-row" data-player-id={r.id}>
                <TableCell className="w-full max-w-0 font-medium whitespace-normal sm:w-auto sm:max-w-none sm:sticky sm:left-0 sm:z-10 sm:bg-background sm:whitespace-nowrap">
                  <div className="flex flex-wrap items-center gap-1">
                    <Link href={`/players/${r.id}`} className="underline-offset-4 hover:underline">
                      {r.fullName}
                    </Link>
                    <InjuryBadge status={r.injuryStatus} detail={r.injuryDetail} />
                  </div>
                  <div className="text-xs font-normal text-muted-foreground sm:hidden">
                    {r.teamAbbrev ?? "FA"} · {r.positions.join("/") || "-"}
                    {league && (
                      <>
                        {" · "}
                        {r.rosteredBy ? r.rosteredBy.name : "FA"}
                      </>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums sm:hidden" data-testid="mobile-value">{mobileValue(r)}</TableCell>
                {renderAction && <TableCell className="min-w-14 px-1" data-testid="action-cell">{renderAction(r)}</TableCell>}
                <TableCell className="hidden sm:table-cell">{r.teamAbbrev ?? "FA"}</TableCell>
                {league && (
                  <TableCell className="hidden sm:table-cell">
                    {r.rosteredBy ? (
                      <Link href={`/leagues/${league.id}/teams/${r.rosteredBy.id}`} className="underline-offset-4 hover:underline">
                        {r.rosteredBy.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">Free agent</span>
                    )}
                  </TableCell>
                )}
                <TableCell className="hidden sm:table-cell">{r.positions.join("/") || "-"}</TableCell>
                <TableCell className="hidden text-right sm:table-cell">{r.gp}</TableCell>
                <TableCell className="hidden text-right sm:table-cell">{fmtNum(r.min)}</TableCell>
                <TableCell className="hidden text-right sm:table-cell">{fmtNum(r.pts)}</TableCell>
                <TableCell className="hidden text-right sm:table-cell">{fmtNum(r.reb)}</TableCell>
                <TableCell className="hidden text-right sm:table-cell">{fmtNum(r.ast)}</TableCell>
                <TableCell className="hidden text-right sm:table-cell">{fmtNum(r.stl)}</TableCell>
                <TableCell className="hidden text-right sm:table-cell">{fmtNum(r.blk)}</TableCell>
                <TableCell className="hidden text-right sm:table-cell">{fmtNum(r.to)}</TableCell>
                <TableCell className="hidden text-right sm:table-cell">{fmtNum(r.tpm)}</TableCell>
                <TableCell className="hidden text-right sm:table-cell">{fmtPct(r.fgPct)}</TableCell>
                <TableCell className="hidden text-right sm:table-cell">{fmtPct(r.ftPct)}</TableCell>
                <TableCell className="hidden text-right sm:table-cell">{fmtNum(r.fpAvg)}</TableCell>
                <TableCell className="hidden text-right sm:table-cell">{fmtNum(r.proj)}</TableCell>
                <TableCell className="hidden text-right font-medium sm:table-cell">{fmtNum(r.fpTotal, 0)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <nav className="flex items-center justify-between text-sm" aria-label="Pagination">
        <span className="text-muted-foreground">
          {result.total} players, page {result.page} of {result.pageCount}
        </span>
        <div className="flex gap-2">
          {result.page > 1 ? (
            <Link href={href({ page: result.page - 1 })} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Previous
            </Link>
          ) : null}
          {result.page < result.pageCount ? (
            <Link href={href({ page: result.page + 1 })} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Next
            </Link>
          ) : null}
        </div>
      </nav>
    </div>
  );
}
