import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { AutoRefresh } from "@/components/nba/auto-refresh";
import { InjuryBadge } from "@/components/nba/injury-badge";
import { CommissionerAddPlayer, DropButton } from "@/components/rosters/roster-controls";
import { BlockToggle } from "@/components/trades/block-controls";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { fmtEtTime, fmtNum } from "@/lib/nba/format";
import { ensureFreshLive } from "@/lib/nba/sync";
import { TEAM_RANGES, loadTeamRoster, type TeamRange, type TodayGame } from "@/lib/rosters/team-view";
import { isPastTradeDeadline } from "@/lib/trades/engine";
import { PLAYOFF_RESULT_LABEL } from "@/lib/seasons/labels";
import { getOwnerPastSeasons } from "@/lib/seasons/service";
import { seasonLabel } from "@/lib/nba/format";
import { listTradeBlock } from "@/lib/trades/service";
import { removeTeamAction } from "../../../actions";
import { RenameTeamForm } from "./team-forms";

const RANGE_LABELS: Record<TeamRange, string> = { season: "Season", "7": "7 days", "15": "15 days", "30": "30 days" };

function todayText(g: TodayGame | null): string {
  if (!g) return "-";
  const vs = `${g.home ? "vs" : "@"} ${g.opponent}`;
  if (g.status === "scheduled") return `${vs} ${fmtEtTime(g.startTime)}`;
  const score = g.teamScore !== null && g.opponentScore !== null ? ` ${g.teamScore}-${g.opponentScore}` : "";
  if (g.status === "in") return `${vs}${score} LIVE`;
  if (g.status === "final") {
    const won = (g.teamScore ?? 0) > (g.opponentScore ?? 0);
    return `${vs} ${won ? "W" : "L"}${score}`;
  }
  return `${vs} ${g.status}`;
}

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string; teamId: string }>;
  searchParams: Promise<{ error?: string; range?: string }>;
}) {
  const { leagueId, teamId } = await params;
  const { error, range: rangeParam } = await searchParams;
  const { user, view } = await loadLeagueView(leagueId);
  const team = view.teams.find((t) => t.id === teamId);
  if (!team) notFound();
  const range = (TEAM_RANGES as readonly string[]).includes(rangeParam ?? "") ? (rangeParam as TeamRange) : "season";
  const isOwner = team.ownerId === user.id;
  const canEdit = isOwner || view.isCommissioner;
  const open = view.league.status === "in_season" || view.league.status === "playoffs";
  const canRemove = view.isCommissioner && view.league.status === "setup" && team.ownerId !== view.league.commissionerId;

  if (open) await ensureFreshLive(db);
  const roster = await loadTeamRoster(db, { leagueId, teamId: team.id, range });
  const blockEntries = await listTradeBlock(db, view.league, { teamId: team.id });
  const blockById = new Map(blockEntries.map((b) => [b.playerId, b]));
  const tradingOpen = view.league.status === "in_season" && !isPastTradeDeadline(view.settings.tradeDeadline, new Date());
  const anyLive = roster.groups.some((g) => g.rows.some((r) => r.todayGame?.status === "in"));
  const base = `/leagues/${leagueId}/teams/${team.id}`;
  const pastSeasons = await getOwnerPastSeasons(db, leagueId, team.ownerId);

  return (
    <div className="grid gap-4">
      {anyLive && <AutoRefresh seconds={45} />}
      <div className="grid gap-1">
        <h2 className="text-xl font-semibold">
          {team.name} <Badge variant="outline">{team.abbrev}</Badge>
        </h2>
        <p className="text-sm text-muted-foreground">
          Owner: {team.ownerUsername}
          {team.ownerId === view.league.commissionerId ? " (commissioner)" : ""}
        </p>
      </div>
      {!isOwner && view.myTeam && tradingOpen && (
        <Link
          href={`/leagues/${leagueId}/trades/new?with=${team.id}`}
          className={buttonVariants({ variant: "outline" }) + " w-fit"}
          data-testid="propose-trade"
        >
          Propose trade
        </Link>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="team-summary">
        <Stat label="Roster" value={`${roster.count} / ${roster.max}`} testId="roster-count" />
        <Stat label={`FP (${RANGE_LABELS[range].toLowerCase()})`} value={fmtNum(roster.totals.total, 0)} testId="period-fp" />
        <Stat label="Win-bonus FP" value={fmtNum(roster.totals.winBonus, 0)} testId="period-bonus" />
        <Stat label="Stat FP" value={fmtNum(roster.totals.statPoints, 0)} />
      </div>

      {pastSeasons.length > 0 && (
        <Card size="sm" data-testid="past-seasons">
          <CardHeader>
            <CardTitle>Past seasons</CardTitle>
            <CardDescription>How {team.ownerUsername} finished in earlier seasons of this league.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-1 text-sm">
              {pastSeasons.map((p) => (
                <li key={p.leagueId} data-testid="past-season-row" className="flex flex-wrap gap-x-2">
                  <span className="font-medium">{seasonLabel(p.season)}</span>
                  <span>
                    {p.teamName}: #{p.finalRank}, {p.wins}-{p.losses}-{p.ties}
                  </span>
                  <span className="text-muted-foreground">{PLAYOFF_RESULT_LABEL[p.playoffResult]}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card data-testid="team-roster">
        <CardHeader>
          <CardTitle>Roster</CardTitle>
          <CardDescription>
            {roster.count === 0
              ? view.league.status === "setup"
                ? "Roster appears after the draft."
                : "No players on this roster."
              : "Grouped by NBA team: every player scores every day, and a win by his team adds the bonus unless he is Out at tip-off. Positions are informational."}
          </CardDescription>
          <nav className="flex flex-wrap gap-1 pt-1" aria-label="Time range">
            {TEAM_RANGES.map((r) => (
              <Link
                key={r}
                href={r === "season" ? base : `${base}?range=${r}`}
                aria-current={r === range ? "true" : undefined}
                className={buttonVariants({ variant: r === range ? "secondary" : "ghost", size: "xs" })}
              >
                {RANGE_LABELS[r]}
              </Link>
            ))}
          </nav>
        </CardHeader>
        {roster.count > 0 && (
          <CardContent className="grid gap-5">
            {roster.groups.map((g) => (
              <section key={g.nbaTeamId ?? "none"} data-testid="nba-group" aria-label={g.name}>
                <h3 className="mb-1 flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
                  <span>{g.abbrev}</span>
                  <span className="font-normal text-muted-foreground">
                    {g.name}
                    {g.record ? ` (${g.record})` : ""} &middot; {g.gamesThisWeek} game{g.gamesThisWeek === 1 ? "" : "s"} this week
                  </span>
                </h3>
                <div className="overflow-x-auto rounded-lg border">
                  <Table data-sticky-first>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Player</TableHead>
                        <TableHead className="hidden sm:table-cell">Pos</TableHead>
                        <TableHead className="hidden sm:table-cell">Today</TableHead>
                        <TableHead className="hidden text-right sm:table-cell" title="Fantasy points per game last season (win bonus included)">Last FP/G</TableHead>
                        <TableHead className="hidden text-right sm:table-cell" title="Total fantasy points last season (win bonus included)">Last FP</TableHead>
                        <TableHead className="hidden text-right sm:table-cell">FP/G</TableHead>
                        <TableHead className="hidden text-right sm:table-cell">L15</TableHead>
                        <TableHead className="hidden text-right sm:table-cell">Proj</TableHead>
                        <TableHead className="text-right">FP</TableHead>
                        <TableHead className="hidden text-right sm:table-cell">Bonus</TableHead>
                        {canEdit && open && <TableHead className="w-px"><span className="sr-only">Actions</span></TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {g.rows.map((p) => (
                        <TableRow key={p.playerId} data-testid="roster-row" data-player-id={p.playerId}>
                          <TableCell className="font-medium whitespace-normal sm:whitespace-nowrap">
                            <Link href={`/players/${p.playerId}`} className="mr-1 underline-offset-4 hover:underline">
                              {p.name}
                            </Link>
                            <InjuryBadge status={p.injuryStatus} detail={p.injuryDetail} />
                            {blockById.has(p.playerId) && (
                              <Badge variant="outline" className="ml-1" title={blockById.get(p.playerId)?.note ?? "On the trade block"} data-testid="on-block-badge">
                                On the block
                              </Badge>
                            )}
                            <div className="text-xs font-normal text-muted-foreground sm:hidden">
                              {p.positions.join("/") || "-"} · {todayText(p.todayGame)}
                            </div>
                          </TableCell>
                          <TableCell className="hidden sm:table-cell">{p.positions.join("/") || "-"}</TableCell>
                          <TableCell className="hidden whitespace-nowrap sm:table-cell">{todayText(p.todayGame)}</TableCell>
                          <TableCell className="hidden text-right tabular-nums sm:table-cell" data-testid="last-fpg">{fmtNum(p.lastAvg)}</TableCell>
                          <TableCell className="hidden text-right tabular-nums sm:table-cell">{fmtNum(p.lastFp, 0)}</TableCell>
                          <TableCell className="hidden text-right tabular-nums sm:table-cell">{fmtNum(p.seasonAvg)}</TableCell>
                          <TableCell className="hidden text-right tabular-nums sm:table-cell">{fmtNum(p.recentAvg)}</TableCell>
                          <TableCell className="hidden text-right tabular-nums sm:table-cell">{fmtNum(p.projection)}</TableCell>
                          <TableCell className="text-right font-medium tabular-nums" title="Season fantasy points incl. win bonus">{fmtNum(p.totalFp, 0)}</TableCell>
                          <TableCell className="hidden text-right tabular-nums sm:table-cell">{fmtNum(p.winBonusFp, 0)}</TableCell>
                          {canEdit && open && (
                            <TableCell className="px-1">
                              <div className="flex flex-col items-end gap-1 sm:flex-row sm:items-center">
                              {isOwner && view.league.status === "in_season" && (
                                <BlockToggle leagueId={leagueId} teamId={team.id} playerId={p.playerId} playerName={p.name} onBlock={blockById.has(p.playerId)} />
                              )}
                              <DropButton leagueId={leagueId} teamId={team.id} playerId={p.playerId} playerName={p.name} />
                            </div>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            ))}
            <p className="text-xs text-muted-foreground">
              FP and Bonus are what each player earned for this team in the selected range (totals above also include
              players since dropped). FP/G and L15 are season and last-15-day averages including the win bonus.
            </p>
          </CardContent>
        )}
      </Card>

      {view.isCommissioner && open && (
        <Card>
          <CardHeader>
            <CardTitle>Add player to this team</CardTitle>
            <CardDescription>
              Commissioner move: skips the daily add limit but not the roster max (drop someone first if the roster is full).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CommissionerAddPlayer leagueId={leagueId} teamId={team.id} />
          </CardContent>
        </Card>
      )}

      {isOwner && open && (
        <Link href={`/leagues/${leagueId}/players`} className={buttonVariants({ variant: "outline" }) + " w-fit"}>
          Find free agents
        </Link>
      )}

      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle>Team details</CardTitle>
          </CardHeader>
          <CardContent>
            <RenameTeamForm leagueId={leagueId} teamId={team.id} name={team.name} abbrev={team.abbrev} />
          </CardContent>
        </Card>
      )}

      {canRemove && (
        <Card>
          <CardHeader>
            <CardTitle>Remove team</CardTitle>
            <CardDescription>Only possible during setup. The schedule will need to be regenerated.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={removeTeamAction.bind(null, leagueId, team.id)}>
              <Button type="submit" variant="destructive">
                Remove team
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <Card size="sm">
      <CardContent>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold tabular-nums" data-testid={testId}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
