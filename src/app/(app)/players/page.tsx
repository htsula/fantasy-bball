import Link from "next/link";
import { z } from "zod";
import { db } from "@/db";
import { InjuryBadge } from "@/components/nba/injury-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireUser } from "@/lib/auth/session";
import { fmtNum, fmtPct, seasonLabel } from "@/lib/nba/format";
import {
  listFilterOptions,
  listPlayers,
  RANGES,
  SORT_KEYS,
  type SortKey,
} from "@/lib/nba/players-query";
import { FANTASY_POSITIONS } from "@/lib/nba/positions";

export const dynamic = "force-dynamic";

const RANGE_LABELS: Record<(typeof RANGES)[number], string> = {
  season: "Season",
  "7": "Last 7 days",
  "15": "Last 15 days",
  "30": "Last 30 days",
};

const paramsSchema = z.object({
  q: z.string().trim().max(80).optional().catch(undefined),
  pos: z.enum(FANTASY_POSITIONS).optional().catch(undefined),
  team: z.coerce.number().int().positive().optional().catch(undefined),
  inj: z.string().max(40).optional().catch(undefined),
  healthy: z.enum(["1"]).optional().catch(undefined),
  range: z.enum(RANGES).catch("season"),
  sort: z.enum(SORT_KEYS).catch("fptotal"),
  dir: z.enum(["asc", "desc"]).catch("desc"),
  page: z.coerce.number().int().min(1).max(1000).catch(1),
});

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
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
  { key: "fpavg", label: "FP/G" },
  { key: "proj", label: "Proj" },
  { key: "fptotal", label: "FP" },
];

export default async function PlayersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const raw = Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const params = paramsSchema.parse(raw);
  const [result, options] = await Promise.all([listPlayers(db, { ...params, healthy: params.healthy === "1" }), listFilterOptions(db)]);

  const href = (over: Partial<Record<string, string | number | undefined>>) => {
    const next: Record<string, string | number | undefined> = {
      q: params.q, pos: params.pos, team: params.team, inj: params.inj, healthy: params.healthy,
      range: params.range === "season" ? undefined : params.range,
      sort: params.sort === "fptotal" ? undefined : params.sort,
      dir: params.dir === "desc" ? undefined : params.dir,
      page: undefined,
      ...over,
    };
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const s = qs.toString();
    return s ? `/players?${s}` : "/players";
  };
  const sortHref = (key: SortKey) =>
    href({ sort: key, dir: params.sort === key ? (params.dir === "desc" ? "asc" : "desc") : key === "name" || key === "to" ? "asc" : "desc" });

  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Players</h1>
        <p className="text-sm text-muted-foreground">
          {result.season ? `${seasonLabel(result.season)} regular season. ` : "No game data yet. "}
          FP uses the default points scoring; Proj blends the last 15 days (0.6) with the season (0.4).
        </p>
      </div>

      <form method="get" action="/players" className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6" aria-label="Player filters">
        <Input name="q" defaultValue={params.q} placeholder="Search name" aria-label="Search name" className="sm:col-span-3 lg:col-span-2" />
        <NativeSelect name="pos" defaultValue={params.pos ?? ""} aria-label="Position">
          <option value="">All positions</option>
          {FANTASY_POSITIONS.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </NativeSelect>
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
        <NativeSelect name="range" defaultValue={params.range} aria-label="Time range">
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
          <Link href="/players" className={buttonVariants({ variant: "outline", size: "sm" })}>Reset</Link>
        </div>
      </form>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 bg-background">
                <Link href={sortHref("name")} className="underline-offset-4 hover:underline">
                  Player{params.sort === "name" ? (params.dir === "asc" ? " ▲" : " ▼") : ""}
                </Link>
              </TableHead>
              <TableHead>Team</TableHead>
              <TableHead>Pos</TableHead>
              {COLUMNS.map((c) => (
                <TableHead key={c.key} className="text-right">
                  <Link href={sortHref(c.key)} className="underline-offset-4 hover:underline">
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
                <TableCell colSpan={3 + COLUMNS.length} className="text-muted-foreground">
                  No players match. {result.total === 0 && "Run a data sync from the Admin page to load players."}
                </TableCell>
              </TableRow>
            )}
            {result.rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="sticky left-0 z-10 bg-background font-medium">
                  <Link href={`/players/${r.id}`} className="underline-offset-4 hover:underline">
                    {r.fullName}
                  </Link>{" "}
                  <InjuryBadge status={r.injuryStatus} detail={r.injuryDetail} />
                </TableCell>
                <TableCell>{r.teamAbbrev ?? "FA"}</TableCell>
                <TableCell>{r.positions.join("/") || "-"}</TableCell>
                <TableCell className="text-right">{r.gp}</TableCell>
                <TableCell className="text-right">{fmtNum(r.min)}</TableCell>
                <TableCell className="text-right">{fmtNum(r.pts)}</TableCell>
                <TableCell className="text-right">{fmtNum(r.reb)}</TableCell>
                <TableCell className="text-right">{fmtNum(r.ast)}</TableCell>
                <TableCell className="text-right">{fmtNum(r.stl)}</TableCell>
                <TableCell className="text-right">{fmtNum(r.blk)}</TableCell>
                <TableCell className="text-right">{fmtNum(r.to)}</TableCell>
                <TableCell className="text-right">{fmtNum(r.tpm)}</TableCell>
                <TableCell className="text-right">{fmtPct(r.fgPct)}</TableCell>
                <TableCell className="text-right">{fmtPct(r.ftPct)}</TableCell>
                <TableCell className="text-right">{fmtNum(r.fpAvg)}</TableCell>
                <TableCell className="text-right">{fmtNum(r.proj)}</TableCell>
                <TableCell className="text-right font-medium">{fmtNum(r.fpTotal, 0)}</TableCell>
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
