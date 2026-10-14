"use client";

import Link from "next/link";
import { useEffect } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { addToQueueAction, makePickAction } from "@/app/(app)/leagues/[leagueId]/draft/actions";
import type { BoardPick, DraftBoard } from "@/lib/draft/board";
import { InjuryBadge } from "@/components/nba/injury-badge";
import { fmtNum } from "@/lib/nba/format";
import { CommissionerControls } from "./commissioner-controls";
import { PicksGrid } from "./picks-grid";
import { PlayerSearch, playersKeyPrefix } from "./player-search";
import { PreDraft } from "./predraft";
import { QueuePanel } from "./queue-panel";
import { Recap } from "./recap";
import { Elapsed, fetchJson } from "./shared";
import { useDraftActions } from "./use-draft-actions";

export type NbaTeamOption = { id: number; abbrev: string };

/** The whole draft page. Polls the board every ~10s and after every action. */
export function DraftRoom({ initial, nbaTeams }: { initial: DraftBoard; nbaTeams: NbaTeamOption[] }) {
  const leagueId = initial.leagueId;
  const { data, mutate } = useSWR<DraftBoard>(`/api/leagues/${leagueId}/draft/board`, fetchJson, {
    fallbackData: initial,
    refreshInterval: 10_000,
    revalidateOnFocus: true,
  });
  const board = data ?? initial;
  const actions = useDraftActions(leagueId, () => mutate());

  // Someone else's pick changes who is available: refresh the player lists right away.
  const { mutate: mutateGlobal } = useSWRConfig();
  const pickCount = board.draft?.picks.length ?? 0;
  useEffect(() => {
    void mutateGlobal((key) => typeof key === "string" && key.startsWith(playersKeyPrefix(leagueId)));
  }, [pickCount, leagueId, mutateGlobal]);

  if (!board.draft) return <PreDraft board={board} nbaTeams={nbaTeams} actions={actions} />;
  return <LiveBoard board={board} nbaTeams={nbaTeams} actions={actions} />;
}

function teamName(board: DraftBoard, id: string) {
  return board.teams.find((t) => t.id === id)?.name ?? "Unknown team";
}

function LiveBoard({
  board,
  nbaTeams,
  actions,
}: {
  board: DraftBoard;
  nbaTeams: NbaTeamOption[];
  actions: ReturnType<typeof useDraftActions>;
}) {
  const draft = board.draft!;
  const { run, pending } = actions;
  const complete = draft.status === "complete";
  const queuedIds = new Set(board.me.queue.map((p) => p.id));
  const takenIds = new Set(draft.picks.map((p) => p.player.id));
  const myTeamId = board.viewer.teamId;

  return (
    <div className="grid gap-6">
      <StatusHeader board={board} />

      {board.me.canPick && (
        <div
          role="status"
          data-testid="your-turn"
          className="rounded-lg border-2 border-primary bg-primary/10 px-4 py-3 text-base font-semibold"
        >
          Your turn!{" "}
          <span className="font-normal">
            {draft.status === "snake"
              ? "You're on the clock. Pick a player below."
              : `Pick ${board.me.waveRemaining} more ${board.me.waveRemaining === 1 ? "player" : "players"} in wave ${draft.wave?.number}. Everyone is picking at once, so be quick.`}
          </span>
        </div>
      )}

      {complete ? (
        <>
          <Recap board={board} />
          <section className="grid gap-2">
            <h2 className="text-lg font-semibold">Draft board</h2>
            <PicksGrid board={board} />
          </section>
        </>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <Card>
              <CardHeader>
                <CardTitle>Available players</CardTitle>
              </CardHeader>
              <CardContent>
                <PlayerSearch
                  leagueId={board.leagueId}
                  nbaTeams={nbaTeams}
                  takenIds={takenIds}
                  actions={(p) => (
                    <>
                      {myTeamId && (
                        <>
                          {queuedIds.has(p.id) ? (
                            <Badge variant="secondary">Queued</Badge>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={pending}
                              onClick={() => run(() => addToQueueAction(board.leagueId, p.id))}
                              data-testid="queue-button"
                            >
                              Queue
                            </Button>
                          )}
                          <Button
                            size="sm"
                            disabled={pending || !board.me.canPick}
                            onClick={() => run(() => makePickAction(board.leagueId, p.id), `Drafted ${p.name}`)}
                            data-testid="draft-button"
                          >
                            Draft
                          </Button>
                        </>
                      )}
                    </>
                  )}
                />
              </CardContent>
            </Card>

            <div className="grid content-start gap-4">
              {myTeamId && <QueuePanel leagueId={board.leagueId} queue={board.me.queue} canPick={board.me.canPick} actions={actions} />}
              {board.viewer.isCommissioner && <CommissionerControls board={board} nbaTeams={nbaTeams} actions={actions} />}
              <RecentPicks board={board} />
            </div>
          </div>

          <section className="grid gap-2">
            <h2 className="text-lg font-semibold">Draft board</h2>
            <PicksGrid board={board} />
          </section>
        </>
      )}

      {myTeamId && (
        <Card size="sm" data-testid="my-roster">
          <CardHeader>
            <CardTitle>
              My roster ({board.me.roster.length}/{board.format.maxRoster})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {board.me.roster.length === 0 ? (
              <p className="text-sm text-muted-foreground">No picks yet.</p>
            ) : (
              <ul className="grid gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {board.me.roster.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-1" data-testid="my-roster-item">
                    <span className="font-medium">{p.name}</span>
                    <InjuryBadge status={p.injuryStatus} detail={p.injuryDetail} />
                    <span className="text-muted-foreground">
                      {p.positions.join("/") || "-"} · {p.nbaTeam ?? "-"} · {fmtNum(p.proj)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatusHeader({ board }: { board: DraftBoard }) {
  const draft = board.draft!;
  const base = `/leagues/${board.leagueId}`;
  return (
    <div className="grid gap-1 rounded-lg border bg-card p-4" data-testid="draft-status">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">
          {draft.status === "snake" && "Snake draft"}
          {draft.status === "waves" && "Wave draft"}
          {draft.status === "complete" && "Draft complete"}
        </h2>
        {draft.status === "snake" && (
          <Badge variant="secondary">
            Round {draft.onClock?.round} of {board.format.snakeRounds}
          </Badge>
        )}
        {draft.status === "waves" && draft.wave && (
          <Badge variant="secondary">
            Wave {draft.wave.number} of {draft.wave.count}
          </Badge>
        )}
        <Badge variant="outline">
          {draft.picks.length}/{board.format.totalPicks} picks
        </Badge>
      </div>
      {draft.status === "snake" && draft.onClock && (
        <p className="text-sm" data-testid="on-the-clock">
          On the clock:{" "}
          <Link href={`${base}/teams/${draft.onClock.teamId}`} className="font-semibold underline-offset-4 hover:underline">
            {teamName(board, draft.onClock.teamId)}
          </Link>{" "}
          (pick #{draft.onClock.pick}) for <Elapsed since={draft.onClock.since} />
        </p>
      )}
      {draft.status === "waves" && draft.wave && (
        <p className="text-sm" data-testid="wave-status">
          Wave {draft.wave.number}: waiting on{" "}
          {draft.wave.waiting.map((w, i) => (
            <span key={w.teamId}>
              {i > 0 && ", "}
              <span className="font-semibold">{teamName(board, w.teamId)}</span> ({w.remaining} left)
            </span>
          ))}
          . Opened <Elapsed since={draft.wave.openedAt ?? board.serverTime} /> ago.
        </p>
      )}
      {draft.status === "complete" && (
        <p className="text-sm text-muted-foreground">
          The season is on. Open any team from the board to see its roster.
        </p>
      )}
    </div>
  );
}

function RecentPicks({ board }: { board: DraftBoard }) {
  const recent: BoardPick[] = board.draft!.recent;
  return (
    <Card size="sm" data-testid="recent-picks">
      <CardHeader>
        <CardTitle>Recent picks</CardTitle>
      </CardHeader>
      <CardContent>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">No picks yet.</p>
        ) : (
          <ol className="grid gap-1 text-sm">
            {recent.map((p) => (
              <li key={p.overall}>
                <span className="text-muted-foreground tabular-nums">#{p.overall}</span>{" "}
                <span className="font-medium">{teamName(board, p.teamId)}</span>: {p.player.name}
                {p.madeByCommissioner && <span className="text-muted-foreground"> (by commish)</span>}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
