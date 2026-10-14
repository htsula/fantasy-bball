"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BoxGame, BoxPlayer, BoxTeam, BoxView, MatchupBoxScore } from "@/lib/matchups/box-score";
import { fmtEtTime, fmtNum, fmtYmd } from "@/lib/nba/format";

const POLL_MS = 30_000;

const fetcher = async (url: string): Promise<MatchupBoxScore> => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
};

export function gameText(g: BoxGame | null): string {
  if (!g) return "No game";
  const vs = `${g.home ? "vs" : "@"} ${g.opponent}`;
  const score = g.teamScore !== null && g.opponentScore !== null ? `${g.teamScore}-${g.opponentScore}` : "";
  if (g.status === "scheduled") return `${vs} ${fmtEtTime(new Date(g.startTime))}`;
  if (g.status === "in") return `${vs} ${score} LIVE${g.period ? ` Q${g.period}` : ""}${g.clock ? ` ${g.clock}` : ""}`;
  if (g.status === "final") return `${(g.teamScore ?? 0) > (g.opponentScore ?? 0) ? "W" : "L"} ${score} ${vs}`;
  return `${vs} ${g.status}`;
}

function dayLabel(date: string) {
  const dow = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short" });
  return `${dow} ${fmtYmd(date).split(" ")[1]}`;
}

export function BoxScoreView({
  leagueId,
  initial,
  myTeamId,
}: {
  leagueId: string;
  initial: MatchupBoxScore;
  myTeamId: string | null;
}) {
  const [view, setView] = useState<BoxView>(initial.view);
  const [side, setSide] = useState<"home" | "away">(
    initial.away && myTeamId === initial.away.teamId ? "away" : "home",
  );
  const key = `/api/leagues/${leagueId}/matchups/${initial.matchup.id}?view=${view}`;
  const { data, error, isValidating } = useSWR(key, fetcher, {
    fallbackData: view === initial.view ? initial : undefined,
    keepPreviousData: true,
    // Poll only while a game is live; otherwise the numbers can't change under the viewer.
    refreshInterval: (latest) => (latest?.anyLive ? POLL_MS : 0),
    revalidateOnFocus: false,
  });
  const box = data ?? initial;
  const loading = isValidating && box.view !== view;

  return (
    <div className="grid gap-4" data-testid="box-score" data-view={box.view}>
      <div className="grid gap-3 md:grid-cols-2">
        <TeamHeader periodView={box.view === "total"} team={box.home} leagueId={leagueId} winner={box.matchup.winnerTeamId === box.home.teamId} final={box.matchup.status === "final"} testId="home" mine={myTeamId === box.home.teamId} />
        {box.away ? (
          <TeamHeader periodView={box.view === "total"} team={box.away} leagueId={leagueId} winner={box.matchup.winnerTeamId === box.away.teamId} final={box.matchup.status === "final"} testId="away" mine={myTeamId === box.away.teamId} />
        ) : (
          <Card size="sm">
            <CardContent className="text-sm text-muted-foreground">Bye week: no opponent, no result this week.</CardContent>
          </Card>
        )}
      </div>

      <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1" aria-label="Matchup days">
        <Button
          type="button"
          size="xs"
          variant={view === "total" ? "secondary" : "ghost"}
          aria-pressed={view === "total"}
          data-testid="period-total-tab"
          onClick={() => setView("total")}
        >
          Period total
        </Button>
        {box.days.map((d) => (
          <Button
            key={d}
            type="button"
            size="xs"
            variant={view === d ? "secondary" : "ghost"}
            aria-pressed={view === d}
            data-testid="day-tab"
            data-date={d}
            onClick={() => setView(d)}
            className="whitespace-nowrap"
          >
            {dayLabel(d)}
            {d === box.today && <span className="ml-1 text-[10px] text-muted-foreground">today</span>}
          </Button>
        ))}
      </nav>
      {error && <p role="alert" className="text-sm text-destructive">Could not refresh: {error.message}</p>}

      {box.away && (
        <div className="flex gap-1 md:hidden" role="group" aria-label="Team">
          {(["home", "away"] as const).map((s) => (
            <Button key={s} type="button" size="sm" variant={side === s ? "secondary" : "outline"} onClick={() => setSide(s)} className="flex-1" data-testid={`side-${s}`}>
              {(s === "home" ? box.home : box.away!).name}
            </Button>
          ))}
        </div>
      )}

      <div className={`grid gap-4 md:grid-cols-2 ${loading ? "opacity-60" : ""}`}>
        <div className={side === "home" ? "" : "hidden md:block"}>
          <TeamTable team={box.home} periodView={box.view === "total"} testId="home" />
        </div>
        {box.away && (
          <div className={side === "away" ? "" : "hidden md:block"}>
            <TeamTable team={box.away} periodView={box.view === "total"} testId="away" />
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {box.anyLive ? "Live: updating every 30 seconds. " : ""}
        FP = stat points + the +team-win bonus (shown separately). The bonus is awarded when a game is final to every player on
        a winning NBA team who was on your roster at tip-off, unless he was listed Out.
      </p>
    </div>
  );
}

function TeamHeader({
  team,
  periodView,
  leagueId,
  winner,
  final,
  testId,
  mine,
}: {
  team: BoxTeam;
  periodView: boolean;
  leagueId: string;
  winner: boolean;
  final: boolean;
  testId: string;
  mine: boolean;
}) {
  const t = team.totals;
  return (
    <Card size="sm" data-testid={`team-header-${testId}`} className={winner ? "ring-2 ring-primary" : undefined}>
      <CardContent className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/leagues/${leagueId}/teams/${team.teamId}`} className="font-semibold underline-offset-4 hover:underline">
            {team.name}
          </Link>
          {mine && <Badge variant="outline">You</Badge>}
          {winner && final && <Badge>Winner</Badge>}
        </div>
        <div className="text-3xl font-bold tabular-nums" data-testid={`team-points-${testId}`}>
          {fmtNum(t.points, 1)}
        </div>
        <div className="grid grid-cols-2 gap-x-3 text-xs text-muted-foreground sm:grid-cols-4">
          <span data-testid={`team-projected-${testId}`}>Proj {fmtNum(t.projected, 1)}</span>
          <span data-testid={`team-bonus-${testId}`}>Bonus {fmtNum(t.winBonus, 0)}</span>
          <span data-testid={`team-played-${testId}`}>{t.gamesPlayed} played</span>
          <span data-testid={`team-remaining-${testId}`}>{t.gamesRemaining} left</span>
        </div>
        {team.adjustmentTotal !== 0 && (
          <div className="text-xs text-muted-foreground" data-testid={`team-adjustment-${testId}`}>
            Includes commissioner adjustment {team.adjustmentTotal > 0 ? "+" : ""}
            {fmtNum(team.adjustmentTotal, 1)}
          </div>
        )}
        {!periodView && team.viewPoints !== t.points && (
          <div className="text-xs text-muted-foreground">Selected day: {fmtNum(team.viewPoints, 1)}</div>
        )}
      </CardContent>
    </Card>
  );
}

function TeamTable({ team, periodView, testId }: { team: BoxTeam; periodView: boolean; testId: string }) {
  return (
    <div className="grid gap-1" data-testid={`box-${testId}`}>
      <h3 className="text-sm font-semibold">{team.name}</h3>
      <div className="overflow-x-auto rounded-lg border">
        <Table data-sticky-first>
          <TableHeader>
            <TableRow>
              <TableHead>Player</TableHead>
              <TableHead className="hidden sm:table-cell">{periodView ? "Games" : "Game"}</TableHead>
              <TableHead className="hidden text-right sm:table-cell">MIN</TableHead>
              <TableHead className="hidden text-right sm:table-cell">PTS</TableHead>
              <TableHead className="hidden text-right sm:table-cell">REB</TableHead>
              <TableHead className="hidden text-right sm:table-cell">AST</TableHead>
              <TableHead className="hidden text-right sm:table-cell">STL</TableHead>
              <TableHead className="hidden text-right sm:table-cell">BLK</TableHead>
              <TableHead className="hidden text-right sm:table-cell">TO</TableHead>
              <TableHead className="hidden text-right sm:table-cell">3PM</TableHead>
              <TableHead className="hidden text-right sm:table-cell">FG</TableHead>
              <TableHead className="hidden text-right sm:table-cell">FT</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Stat</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Bonus</TableHead>
              <TableHead className="text-right">FP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {team.players.length === 0 && (
              <TableRow>
                <TableCell colSpan={15} className="text-muted-foreground ">
                  No players.
                </TableCell>
              </TableRow>
            )}
            {team.players.map((p) => (
              <PlayerRow key={p.playerId} p={p} periodView={periodView} />
            ))}
          </TableBody>
          <tfoot>
            <TableRow>
              <TableCell colSpan={12} className="hidden font-medium sm:table-cell">
                {periodView && team.adjustments.length ? "Players" : "Total"}
              </TableCell>
              <TableCell className="font-medium sm:hidden">{periodView && team.adjustments.length ? "Players" : "Total"}</TableCell>
              <TableCell className="hidden text-right tabular-nums sm:table-cell">{fmtNum(team.viewPoints - team.viewWinBonus, 0)}</TableCell>
              <TableCell className="hidden text-right tabular-nums sm:table-cell">{fmtNum(team.viewWinBonus, 0)}</TableCell>
              <TableCell className="text-right font-semibold tabular-nums" data-testid={`view-total-${testId}`}>
                {fmtNum(team.viewPoints, 1)}
              </TableCell>
            </TableRow>
            {periodView &&
              team.adjustments.map((a) => (
                <TableRow key={a.id} data-testid="adjustment-line">
                  <TableCell colSpan={14} className="hidden text-sm sm:table-cell">
                    Commissioner adjustment {a.points > 0 ? "+" : ""}
                    {fmtNum(a.points, 1)} ({a.reason})
                    {a.actorUsername ? <span className="text-xs text-muted-foreground"> by {a.actorUsername}</span> : null}
                  </TableCell>
                  <TableCell className="whitespace-normal text-xs sm:hidden">
                    Adjustment ({a.reason})
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {a.points > 0 ? "+" : ""}
                    {fmtNum(a.points, 1)}
                  </TableCell>
                </TableRow>
              ))}
            {periodView && team.adjustments.length > 0 && (
              <TableRow>
                <TableCell colSpan={14} className="hidden font-medium sm:table-cell">
                  Total with adjustments
                </TableCell>
                <TableCell className="whitespace-normal font-medium sm:hidden">Total with adjustments</TableCell>
                <TableCell className="text-right font-semibold tabular-nums" data-testid={`period-total-${testId}`}>
                  {fmtNum(team.viewPoints + team.adjustmentTotal, 1)}
                </TableCell>
              </TableRow>
            )}
          </tfoot>
        </Table>
      </div>
    </div>
  );
}

function PlayerRow({ p, periodView }: { p: BoxPlayer; periodView: boolean }) {
  const l = p.line;
  const dash = (v: number | undefined) => (l ? String(v) : "-");
  return (
    <TableRow data-testid="player-row" data-player-id={p.playerId} className={!p.rostered && !p.games ? "opacity-60" : undefined}>
      <TableCell className="font-medium sm:whitespace-nowrap">
        <Link href={`/players/${p.playerId}`} className="underline-offset-4 hover:underline">
          {p.name}
        </Link>{" "}
        <span className="text-xs font-normal text-muted-foreground">{p.nbaAbbrev}</span>
        {p.injuryStatus && <span className="ml-1 text-xs text-destructive">{p.injuryStatus}</span>}
        <div className="text-xs font-normal text-muted-foreground sm:hidden" data-testid="game-line">
          {periodView ? `${p.games} game${p.games === 1 ? "" : "s"}` : gameText(p.game)}
        </div>
      </TableCell>
      <TableCell className="hidden whitespace-nowrap text-xs sm:table-cell" data-testid="game-cell">
        {periodView ? `${p.games} game${p.games === 1 ? "" : "s"}` : gameText(p.game)}
      </TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">{dash(l?.min)}</TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">{dash(l?.pts)}</TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">{dash(l?.reb)}</TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">{dash(l?.ast)}</TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">{dash(l?.stl)}</TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">{dash(l?.blk)}</TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">{dash(l?.to)}</TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">{dash(l?.tpm)}</TableCell>
      <TableCell className="hidden whitespace-nowrap text-right tabular-nums sm:table-cell">{l ? `${l.fgm}-${l.fga}` : "-"}</TableCell>
      <TableCell className="hidden whitespace-nowrap text-right tabular-nums sm:table-cell">{l ? `${l.ftm}-${l.fta}` : "-"}</TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell" data-testid="stat-cell">
        {p.games ? fmtNum(p.statPoints, 0) : "-"}
      </TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell" data-testid="bonus-cell">
        {p.winBonus ? `+${fmtNum(p.winBonus, 0)}` : p.games ? "0" : "-"}
      </TableCell>
      <TableCell
        className="text-right font-semibold tabular-nums max-sm:after:block max-sm:after:text-[11px] max-sm:after:font-normal max-sm:after:text-muted-foreground max-sm:after:content-[attr(data-bonus)]"
        data-testid="fp-cell"
        data-bonus={p.games > 0 && p.winBonus > 0 ? `+${fmtNum(p.winBonus, 0)} win` : undefined}
      >
        {p.games ? fmtNum(p.total, 1) : "-"}
      </TableCell>
    </TableRow>
  );
}
