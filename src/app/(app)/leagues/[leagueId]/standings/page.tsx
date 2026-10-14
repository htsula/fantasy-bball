import Link from "next/link";
import { db } from "@/db";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { getStandings } from "@/lib/matchups/service";
import { fmtNum } from "@/lib/nba/format";

export const dynamic = "force-dynamic";

export default async function StandingsPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const { view } = await loadLeagueView(leagueId);
  const rows = await getStandings(db, view.league.id);
  const base = `/leagues/${view.league.id}`;
  const cut = Math.min(view.settings.playoffTeams, rows.length);

  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <h2 className="text-xl font-semibold">Standings</h2>
        <p className="text-sm text-muted-foreground">
          Regular season only. Ties count as half a win. Tiebreakers: win %, head-to-head among the tied teams, points for,
          points against (lower is better), then team name. The top {view.settings.playoffTeams} make the playoffs.
        </p>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <Table data-testid="standings-table">
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">#</TableHead>
              <TableHead>Team</TableHead>
              <TableHead className="text-right">W-L-T</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Pct</TableHead>
              <TableHead className="hidden text-right sm:table-cell">GB</TableHead>
              <TableHead className="text-right">PF</TableHead>
              <TableHead className="hidden text-right sm:table-cell">PA</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Streak</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow
                key={r.teamId}
                data-testid="standings-row"
                data-rank={r.rank}
                data-in-playoffs={r.rank <= cut ? "true" : "false"}
                className={r.rank === cut && rows.length > cut ? "border-b-2 border-b-primary" : undefined}
              >
                <TableCell className="tabular-nums">{r.rank}</TableCell>
                <TableCell className="font-medium">
                  <Link href={`${base}/teams/${r.teamId}`} className="underline-offset-4 hover:underline">
                    {r.name}
                  </Link>{" "}
                  {r.teamId === view.myTeam?.id && <Badge variant="outline">You</Badge>}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums" data-testid="record">
                  {r.wins}-{r.losses}-{r.ties}
                </TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{r.gamesPlayed ? r.winPct.toFixed(3).replace(/^0/, "") : "-"}</TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{r.gamesBack === 0 ? "-" : fmtNum(r.gamesBack, 1)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtNum(r.pointsFor, 1)}</TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{fmtNum(r.pointsAgainst, 1)}</TableCell>
                <TableCell className="hidden text-right sm:table-cell">{r.streak || "-"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {rows.length > cut && cut > 0 && (
        <p className="text-xs text-muted-foreground">The line under rank {cut} marks the playoff cut.</p>
      )}
    </div>
  );
}
