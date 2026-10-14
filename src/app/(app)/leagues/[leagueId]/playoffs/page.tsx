import Link from "next/link";
import { Trophy } from "lucide-react";
import { db } from "@/db";
import { AutoRefresh } from "@/components/nba/auto-refresh";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { getBracket, previewSeeds, type BracketSlotView, type BracketTeam } from "@/lib/playoffs/service";
import { fmtNum, fmtYmd } from "@/lib/nba/format";
import { ensureFreshLive } from "@/lib/nba/sync";
import { OverrideWinner, ReseedButton } from "./playoff-controls";

export const dynamic = "force-dynamic";

export default async function PlayoffsPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const { view } = await loadLeagueView(leagueId);
  const { league, settings, myTeam, isCommissioner } = view;
  const base = `/leagues/${league.id}`;
  if (league.status === "playoffs") await ensureFreshLive(db);
  const bracket = await getBracket(db, league.id);
  const anyLive = bracket.rounds.some((r) => r.slots.some((s) => s.status === "live"));

  if (!bracket.seeded) {
    const preview = league.status === "in_season" ? await previewSeeds(db, league.id, settings.playoffTeams) : [];
    return (
      <div className="grid gap-4">
        <h2 className="text-xl font-semibold">Playoffs</h2>
        <p className="text-sm text-muted-foreground" data-testid="bracket-empty">
          The bracket is set when the regular season ends: the top {settings.playoffTeams} teams in the standings are seeded
          {settings.playoffTeams === 6 ? " (seeds 1 and 2 get a bye in round 1)" : ""}. Higher seeds win ties.
        </p>
        {preview.length > 0 && (
          <Card size="sm">
            <CardHeader>
              <CardTitle>If the season ended today</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="grid gap-1 text-sm">
                {preview.map((p) => (
                  <li key={p.teamId}>
                    #{p.seed} {p.name}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  const side = (slot: BracketSlotView, t: BracketTeam | null, score: number | null) => {
    if (!t) {
      return (
        <div className="flex items-center justify-between gap-2 px-2 py-1 text-muted-foreground" data-testid="bracket-team" data-tbd="true">
          <span>{slot.bye ? "Bye" : "TBD"}</span>
        </div>
      );
    }
    const won = slot.winnerTeamId === t.teamId;
    const lost = slot.winnerTeamId !== null && !won;
    return (
      <div
        className={`flex items-center justify-between gap-2 rounded-md px-2 py-1 ${won ? "bg-primary/10 font-semibold" : ""} ${lost ? "text-muted-foreground" : ""}`}
        data-testid="bracket-team"
        data-winner={won ? "true" : undefined}
      >
        <span className="flex min-w-0 items-center gap-2">
          {t.seed !== null && (
            <Badge variant="outline" data-testid="seed">
              {t.seed}
            </Badge>
          )}
          <Link href={`${base}/teams/${t.teamId}`} className="truncate underline-offset-4 hover:underline">
            {t.name}
          </Link>
          {t.teamId === myTeam?.id && <Badge variant="secondary">You</Badge>}
        </span>
        <span className="tabular-nums" data-testid="bracket-score">
          {score === null ? "" : fmtNum(score, 1)}
        </span>
      </div>
    );
  };

  return (
    <div className="grid gap-4">
      {anyLive && <AutoRefresh seconds={45} />}
      <div className="grid gap-1">
        <h2 className="text-xl font-semibold">Playoffs</h2>
        <span className="text-sm text-muted-foreground">
          Top {settings.playoffTeams} teams, {bracket.rounds.length} round{bracket.rounds.length === 1 ? "" : "s"}. Ties go to the higher seed
          {settings.playoffRoundLength === 2 ? "; each round is decided on the combined points of two weeks" : ""}.
        </span>
      </div>

      {bracket.champion && (
        <Card data-testid="champion" className="border-primary">
          <CardContent className="flex items-center gap-3">
            <Trophy className="size-8 text-amber-500" aria-hidden />
            <div>
              <p className="text-lg font-bold">{bracket.champion.name} are champions!</p>
              {bracket.runnerUp && <p className="text-sm text-muted-foreground">Runner-up: {bracket.runnerUp.name}</p>}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-flow-col md:auto-cols-fr" data-testid="bracket">
        {bracket.rounds.map((round) => (
          <section key={round.round} className="grid content-start gap-3" aria-label={round.label} data-testid="bracket-round">
            <div>
              <h3 className="font-semibold">{round.label}</h3>
              <p className="text-xs text-muted-foreground">
                {round.periods.length
                  ? `${fmtYmd(round.periods[0].startDate)} - ${fmtYmd(round.periods[round.periods.length - 1].endDate)}`
                  : ""}
              </p>
            </div>
            {round.slots.map((slot) => (
              <Card key={slot.id} size="sm" data-testid="bracket-slot" data-status={slot.status} data-bye={slot.bye ? "true" : undefined}>
                <CardContent className="grid gap-1">
                  {side(slot, slot.teamA, slot.scoreA)}
                  {side(slot, slot.teamB, slot.scoreB)}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 pt-1 text-xs text-muted-foreground">
                    {slot.status === "tbd" && !slot.bye && <span>Waiting for the previous round</span>}
                    {slot.bye && <span>Advances without playing</span>}
                    {slot.status === "live" && <Badge variant="outline">Live</Badge>}
                    {slot.status === "final" && <Badge variant="secondary">Final</Badge>}
                    {slot.overridden && (
                      <span title={slot.overrideNote ?? undefined} data-testid="overridden">
                        Set by commissioner{slot.overrideNote ? `: ${slot.overrideNote}` : ""}
                      </span>
                    )}
                    {slot.legs.map((leg, i) => (
                      <Link key={leg.matchupId} href={`${base}/matchup/${leg.matchupId}`} className="underline underline-offset-4">
                        {slot.legs.length > 1 ? `Box score (week ${i + 1})` : "Box score"}
                      </Link>
                    ))}
                  </div>
                  {isCommissioner && slot.teamA && slot.teamB && (
                    <div className="px-2 pt-1">
                      <OverrideWinner
                        leagueId={league.id}
                        slotId={slot.id}
                        teams={[slot.teamA, slot.teamB].map((t) => ({ teamId: t.teamId, name: t.name }))}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </section>
        ))}
      </div>

      {isCommissioner && bracket.canReseed && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Re-seed</CardTitle>
            <CardDescription>
              Rebuilds the bracket from the current standings. Only possible before the first playoff game of round 1 starts
              (for example after correcting a regular-season result).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ReseedButton leagueId={league.id} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
