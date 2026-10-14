import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { DraftBoard } from "@/lib/draft/board";
import { fmtNum } from "@/lib/nba/format";

/** Draft recap: each team's picks by round plus the sum of projected points per game. */
export function Recap({ board }: { board: DraftBoard }) {
  const recap = board.recap;
  if (!recap) return null;
  const byTeam = new Map(board.teams.map((t) => [t.id, t]));
  const ranked = [...recap.teams].sort((a, b) => b.projectedTotal - a.projectedTotal);
  return (
    <Card data-testid="draft-recap">
      <CardHeader>
        <CardTitle>Draft recap</CardTitle>
        <CardDescription>
          Each roster by round. &quot;Proj&quot; adds up the projected fantasy points per game of every drafted player.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        {ranked.map((r) => {
          const team = byTeam.get(r.teamId);
          if (!team) return null;
          return (
            <section key={r.teamId} className="grid gap-2 rounded-lg border p-3" data-testid="recap-team">
              <div className="flex items-baseline justify-between gap-2">
                <Link href={`/leagues/${board.leagueId}/teams/${team.id}`} className="font-semibold underline-offset-4 hover:underline">
                  {team.name}
                </Link>
                <span className="text-sm text-muted-foreground">Proj {fmtNum(r.projectedTotal)}</span>
              </div>
              <ol className="grid gap-0.5 text-sm">
                {r.picks.map((p) => (
                  <li key={p.overall} className="flex justify-between gap-2">
                    <span>
                      <span className="mr-2 inline-block w-6 text-muted-foreground tabular-nums">R{p.round}</span>
                      {p.player.name}
                    </span>
                    <span className="text-muted-foreground">{p.player.nbaTeam ?? "-"}</span>
                  </li>
                ))}
              </ol>
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}
