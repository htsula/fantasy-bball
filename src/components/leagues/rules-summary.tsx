import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { maxRoster, snakeRounds, waves } from "@/lib/fantasy/roster-size";
import { SCORING_KEYS, SCORING_LABELS, type LeagueSettings } from "@/lib/fantasy/settings";
import { fmtYmd } from "@/lib/nba/format";

const fmtPts = (n: number) => (n > 0 ? `+${n}` : String(n));

export function waveText(teamCount: number, s: LeagueSettings): string {
  const w = waves(teamCount, s);
  if (w.count === 0) return "None (the whole draft is snake)";
  if (!w.lastWaveShort) return `${w.count} waves of ${s.waveSize}`;
  return `${w.count} waves (${w.fullWaves} of ${s.waveSize}, then a final wave of ${w.lastWaveSize})`;
}

const TRADE_TEXT = {
  none: "Trades go through immediately.",
  commissioner: "The commissioner reviews each accepted trade before it is processed.",
  league_vote: "Accepted trades can be vetoed by a league vote.",
} as const;

/** Plain-language summary of every league rule (visible to all members). */
export function RulesSummary({ settings: s, teamCount }: { settings: LeagueSettings; teamCount: number }) {
  const n = Math.max(teamCount, 1);
  const max = maxRoster(n, s);
  const snake = snakeRounds(n, s);
  const dates =
    s.regularSeasonStart && s.regularSeasonEnd
      ? `${fmtYmd(s.regularSeasonStart, true)} to ${fmtYmd(s.regularSeasonEnd, true)}`
      : "not set yet";
  return (
    <div className="grid gap-4" data-testid="league-rules">
      <Card>
        <CardHeader>
          <CardTitle>League rules</CardTitle>
          <CardDescription>Head-to-head points. There are no lineups: every player on your roster scores every day.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          <section className="grid gap-2">
            <h3 className="font-semibold">Scoring</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Stat</TableHead>
                  <TableHead className="text-right">Points</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {SCORING_KEYS.map((k) => (
                  <TableRow key={k}>
                    <TableCell>{SCORING_LABELS[k]}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtPts(s.scoring[k])}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-sm text-muted-foreground">
              Team win bonus: a player earns {fmtPts(s.scoring.teamWin)} whenever his NBA team wins and he is on your
              roster that day, even if he doesn&apos;t play, unless he is listed as Out at tip-off.
            </p>
          </section>

          <section className="grid gap-1 text-sm">
            <h3 className="text-base font-semibold">Rosters</h3>
            <p>
              Maximum roster size is the smaller of {s.rosterCap} and {s.rosterPool} divided by the number of teams
              (rounded down). With {n} {n === 1 ? "team" : "teams"} that is <strong>{max} players</strong>. It is locked
              when the draft starts. You may carry fewer players (dropping is always allowed) but never more.
            </p>
          </section>

          <section className="grid gap-1 text-sm">
            <h3 className="text-base font-semibold">Draft</h3>
            <p>
              Snake phase: about {s.snakeTarget} picks in total, which is {snake} {snake === 1 ? "round" : "rounds"} with {n}{" "}
              {n === 1 ? "team" : "teams"} (never more than the roster maximum).
            </p>
            <p>
              Wave phase: {waveText(n, s)}. In a wave everyone picks at the same time, {s.waveSize} players each,
              first come first served.
            </p>
          </section>

          <section className="grid gap-1 text-sm">
            <h3 className="text-base font-semibold">Free agency</h3>
            <p>
              Adds are instant, first come first served, up to {s.addsPerDay} per team per day (resets at midnight ET).
              Drops are unlimited. There are no waivers.
            </p>
          </section>

          <section className="grid gap-1 text-sm">
            <h3 className="text-base font-semibold">Trades</h3>
            <p>{TRADE_TEXT[s.tradeReview]}</p>
            {s.tradeReview !== "none" && (
              <p>
                Review period: {s.tradeReviewHours} hours
                {s.tradeReview === "league_vote" ? `; ${s.vetoVotesNeeded} veto votes cancel a trade` : ""}.
              </p>
            )}
            <p>Trade deadline: {s.tradeDeadline ? fmtYmd(s.tradeDeadline, true) : "none"}.</p>
          </section>

          <section className="grid gap-1 text-sm">
            <h3 className="text-base font-semibold">Schedule and playoffs</h3>
            <p>Regular season: {dates}. Matchups are weekly (Monday to Sunday, Eastern time).</p>
            <p>
              Top {s.playoffTeams} teams make the playoffs; each round lasts {s.playoffRoundLength}{" "}
              {s.playoffRoundLength === 1 ? "week" : "weeks"}.
              {s.playoffTeams === 6 ? " The top 2 seeds get a first-round bye." : ""}
            </p>
            <p>Keepers: {s.keepers === 0 ? "none" : `${s.keepers} per team`}.</p>
          </section>
        </CardContent>
      </Card>
    </div>
  );
}
