"use client";

import { useEffect, useState, type ReactNode } from "react";
import useSWR from "swr";
import { InjuryBadge } from "@/components/nba/injury-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BoardPlayer } from "@/lib/draft/board";
import { fmtNum } from "@/lib/nba/format";
import { FANTASY_POSITIONS } from "@/lib/nba/positions";
import { fetchJson } from "./shared";

type PlayersResponse = { players: BoardPlayer[]; total: number; page: number; pageSize: number; pageCount: number };

export const playersKeyPrefix = (leagueId: string) => `/api/leagues/${leagueId}/draft/players`;

/** Searchable, filterable list of draftable players ranked by projection. */
export function PlayerSearch({
  leagueId,
  nbaTeams,
  actions,
  pageSize = 25,
  refreshMs = 10_000,
  compact = false,
}: {
  leagueId: string;
  nbaTeams: { id: number; abbrev: string }[];
  actions: (player: BoardPlayer) => ReactNode;
  pageSize?: number;
  refreshMs?: number;
  compact?: boolean;
}) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [pos, setPos] = useState("");
  const [team, setTeam] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);

  const params = new URLSearchParams({ page: String(page), size: String(pageSize) });
  if (debounced) params.set("q", debounced);
  if (pos) params.set("pos", pos);
  if (team) params.set("team", team);
  const { data, error, isLoading } = useSWR<PlayersResponse>(`${playersKeyPrefix(leagueId)}?${params}`, fetchJson, {
    refreshInterval: refreshMs,
    keepPreviousData: true,
  });

  const reset = () => setPage(1);
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

      {error && <p className="text-sm text-destructive">Couldn&apos;t load players. Retrying...</p>}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">#</TableHead>
              <TableHead>Player</TableHead>
              {!compact && <TableHead>Team</TableHead>}
              <TableHead className="text-right">FP/G</TableHead>
              <TableHead className="text-right">Proj</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.players ?? []).map((p, i) => (
              <TableRow key={p.id} data-testid="player-row" data-player-id={p.id}>
                <TableCell className="text-muted-foreground tabular-nums">{offset + i + 1}</TableCell>
                <TableCell className="font-medium">
                  <div className="flex flex-wrap items-center gap-1">
                    <span>{p.name}</span>
                    <InjuryBadge status={p.injuryStatus} detail={p.injuryDetail} />
                  </div>
                  <div className="text-xs font-normal text-muted-foreground">
                    {p.positions.join("/") || "-"}
                    {compact && p.nbaTeam ? ` · ${p.nbaTeam}` : ""}
                  </div>
                </TableCell>
                {!compact && <TableCell>{p.nbaTeam ?? "-"}</TableCell>}
                <TableCell className="text-right tabular-nums">{fmtNum(p.avg)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtNum(p.proj)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">{actions(p)}</div>
                </TableCell>
              </TableRow>
            ))}
            {data && data.players.length === 0 && (
              <TableRow>
                <TableCell colSpan={compact ? 5 : 6} className="py-6 text-center text-muted-foreground">
                  No players match.
                </TableCell>
              </TableRow>
            )}
            {!data && isLoading && (
              <TableRow>
                <TableCell colSpan={compact ? 5 : 6} className="py-6 text-center text-muted-foreground">
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
