"use client";

import { useEffect, useState, type ReactNode } from "react";
import useSWR from "swr";
import { cn } from "cn";
import { InjuryBadge } from "@/components/nba/injury-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BoardPlayer, DraftSortKey } from "@/lib/draft/board";
import { fmtNum } from "@/lib/nba/format";
import { FANTASY_POSITIONS } from "@/lib/nba/positions";
import { fetchJson } from "./shared";

type PlayersResponse = { players: BoardPlayer[]; total: number; page: number; pageSize: number; pageCount: number };

export const playersKeyPrefix = (leagueId: string) => `/api/leagues/${leagueId}/draft/players`;

/** Searchable, filterable list of draftable players; default order is last season's total FP, descending. */
export function PlayerSearch({
  leagueId,
  nbaTeams,
  actions,
  pageSize = 25,
  refreshMs = 10_000,
  compact = false,
  takenIds,
}: {
  leagueId: string;
  nbaTeams: { id: number; abbrev: string }[];
  actions: (player: BoardPlayer) => ReactNode;
  pageSize?: number;
  refreshMs?: number;
  compact?: boolean;
  /** Players known (from the live board) to be drafted already: hidden even while the list is still refreshing. */
  takenIds?: ReadonlySet<number>;
}) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [pos, setPos] = useState("");
  const [team, setTeam] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<DraftSortKey>("lastfp");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);

  const params = new URLSearchParams({ page: String(page), size: String(pageSize) });
  if (debounced) params.set("q", debounced);
  if (pos) params.set("pos", pos);
  if (team) params.set("team", team);
  params.set("sort", sort);
  params.set("dir", dir);
  const { data, error, isLoading } = useSWR<PlayersResponse>(`${playersKeyPrefix(leagueId)}?${params}`, fetchJson, {
    refreshInterval: refreshMs,
    keepPreviousData: true,
  });

  const reset = () => setPage(1);
  const toggleSort = (key: DraftSortKey) => {
    if (key === sort) setDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSort(key);
      setDir(key === "name" ? "asc" : "desc");
    }
    reset();
  };
  const sortHead = (key: DraftSortKey, label: string, title: string, right = true, extra = "") => (
    <TableHead className={cn(right && "text-right", extra)} aria-sort={sort === key ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" title={title} onClick={() => toggleSort(key)} className="underline-offset-4 hover:underline" data-testid={`sort-${key}`}>
        {label}
        {sort === key ? (dir === "asc" ? " ▲" : " ▼") : ""}
      </button>
    </TableHead>
  );
  const offset = ((data?.page ?? page) - 1) * pageSize;

  return (
    <div className="grid gap-3" data-testid="player-search">
      <div className="grid gap-2 sm:grid-cols-4">
        <Input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            reset();
          }}
          placeholder="Search players"
          aria-label="Search players"
          className="sm:col-span-2"
        />
        <NativeSelect
          value={pos}
          onChange={(e) => {
            setPos(e.target.value);
            reset();
          }}
          aria-label="Position"
        >
          <option value="">All positions</option>
          {FANTASY_POSITIONS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          value={team}
          onChange={(e) => {
            setTeam(e.target.value);
            reset();
          }}
          aria-label="NBA team"
        >
          <option value="">All teams</option>
          {nbaTeams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.abbrev}
            </option>
          ))}
        </NativeSelect>
      </div>

      <NativeSelect
        className="sm:hidden"
        aria-label="Sort by"
        value={sort}
        onChange={(e) => {
          setSort(e.target.value as DraftSortKey);
          setDir(e.target.value === "name" ? "asc" : "desc");
          reset();
        }}
      >
        <option value="lastfp">Sort: Last season FP</option>
        <option value="lastavg">Sort: Last season FP/G</option>
        <option value="curavg">Sort: This season FP/G</option>
        <option value="proj">Sort: Projection</option>
        <option value="name">Sort: Name</option>
      </NativeSelect>

      {error && <p className="text-sm text-destructive">Couldn&apos;t load players. Retrying...</p>}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="hidden w-8 sm:table-cell">#</TableHead>
              {sortHead("name", "Player", "Sort by name", false)}
              {!compact && <TableHead className="hidden sm:table-cell">Team</TableHead>}
              {sortHead("lastfp", "Last FP", "Total fantasy points last season (league scoring, win bonus included). Default sort.")}
              {sortHead("lastavg", "Last FP/G", "Fantasy points per game last season (win bonus included)", true, "hidden sm:table-cell")}
              {sortHead("curavg", "FP/G", "Fantasy points per game this season (win bonus included)", true, "hidden sm:table-cell")}
              {sortHead("proj", "Proj", "Projected fantasy points per game", true, "hidden sm:table-cell")}
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.players ?? []).filter((p) => !takenIds?.has(p.id)).map((p, i) => (
              <TableRow key={p.id} data-testid="player-row" data-player-id={p.id}>
                <TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">{offset + i + 1}</TableCell>
                <TableCell className="font-medium">
                  <div className="flex flex-wrap items-center gap-1">
                    <span>{p.name}</span>
                    <InjuryBadge status={p.injuryStatus} detail={p.injuryDetail} />
                  </div>
                  <div className="text-xs font-normal text-muted-foreground">
                    {p.positions.join("/") || "-"}
                    {p.nbaTeam ? <span className={compact ? undefined : "sm:hidden"}> · {p.nbaTeam}</span> : null}
                  </div>
                </TableCell>
                {!compact && <TableCell className="hidden sm:table-cell">{p.nbaTeam ?? "-"}</TableCell>}
                <TableCell className="text-right tabular-nums" data-testid="last-fp">{fmtNum(p.lastFp, 0)}</TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{fmtNum(p.lastAvg)}</TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{fmtNum(p.curAvg)}</TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{fmtNum(p.proj)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">{actions(p)}</div>
                </TableCell>
              </TableRow>
            ))}
            {data && data.players.every((p) => takenIds?.has(p.id)) && (
              <TableRow>
                <TableCell colSpan={compact ? 7 : 8} className="py-6 text-center text-muted-foreground">
                  No players match.
                </TableCell>
              </TableRow>
            )}
            {!data && isLoading && (
              <TableRow>
                <TableCell colSpan={compact ? 7 : 8} className="py-6 text-center text-muted-foreground">
                  Loading players...
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {data && data.pageCount > 1 && (
        <div className="flex items-center justify-between text-sm">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            Previous
          </Button>
          <span className="text-muted-foreground">
            Page {data.page} of {data.pageCount} ({data.total} players)
          </span>
          <Button variant="outline" size="sm" disabled={page >= data.pageCount} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
