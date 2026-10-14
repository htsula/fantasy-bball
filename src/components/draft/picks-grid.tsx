"use client";

import Link from "next/link";
import type { DraftBoard } from "@/lib/draft/board";

type Draft = NonNullable<DraftBoard["draft"]>;

/** Rounds x teams grid: snake rows first (with direction arrows), then wave rows. */
export function PicksGrid({ board }: { board: DraftBoard }) {
  const draft = board.draft as Draft;
  const { format, teams } = board;
  const byCell = new Map(draft.picks.map((p) => [`${p.teamId}:${p.round}`, p]));
  const rounds = Array.from({ length: format.totalRounds }, (_, i) => i + 1);
  const waveOf = (round: number) => Math.floor((round - format.snakeRounds - 1) / format.waveSize) + 1;

  return (
    <div className="overflow-x-auto rounded-lg border" data-testid="picks-grid">
      <table className="w-full min-w-max border-collapse text-xs">
        <thead>
          <tr className="bg-muted/50">
            <th className="sticky left-0 z-10 bg-muted px-2 py-2 text-left font-medium">Round</th>
            {teams.map((t) => (
              <th key={t.id} className="min-w-28 px-2 py-2 text-left font-medium">
                <Link href={`/leagues/${board.leagueId}/teams/${t.id}`} className="hover:underline">
                  {t.abbrev}
                </Link>
                {t.id === board.viewer.teamId && <span className="ml-1 text-primary">(you)</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rounds.map((round) => {
            const snake = round <= format.snakeRounds;
            const forward = round % 2 === 1;
            return (
              <tr key={round} className="border-t">
                <th className="sticky left-0 z-10 bg-background px-2 py-1.5 text-left font-medium whitespace-nowrap">
                  R{round}{" "}
                  <span className="font-normal text-muted-foreground">
                    {snake ? (forward ? "→" : "←") : `W${waveOf(round)}`}
                  </span>
                </th>
                {teams.map((t) => {
                  const pick = byCell.get(`${t.id}:${round}`);
                  const onClock = draft.onClock && snake && draft.onClock.teamId === t.id && draft.onClock.round === round;
                  return (
                    <td
                      key={t.id}
                      data-testid="grid-cell"
                      className={`px-2 py-1.5 align-top ${onClock ? "bg-primary/15 ring-1 ring-primary ring-inset" : ""} ${
                        t.id === board.viewer.teamId ? "bg-muted/40" : ""
                      }`}
                    >
                      {pick ? (
                        <div className="leading-tight">
                          <div className="font-medium">{pick.player.name}</div>
                          <div className="text-muted-foreground">
                            #{pick.overall} · {pick.player.nbaTeam ?? "-"}
                            {pick.madeByCommissioner ? " · by commish" : ""}
                          </div>
                        </div>
                      ) : onClock ? (
                        <span className="font-medium text-primary">On the clock</span>
                      ) : (
                        <span className="text-muted-foreground">&nbsp;</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
