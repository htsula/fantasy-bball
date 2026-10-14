"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { addToQueueAction, startDraftAction } from "@/app/(app)/leagues/[leagueId]/draft/actions";
import type { DraftBoard } from "@/lib/draft/board";
import { PlayerSearch } from "./player-search";
import { QueuePanel } from "./queue-panel";
import { waveBreakdown } from "./shared";
import type { useDraftActions } from "./use-draft-actions";

/** Before the commissioner presses Start: format, teams, and the queue builder. */
export function PreDraft({
  board,
  nbaTeams,
  actions,
}: {
  board: DraftBoard;
  nbaTeams: { id: number; abbrev: string }[];
  actions: ReturnType<typeof useDraftActions>;
}) {
  const { run, pending } = actions;
  const [confirm, setConfirm] = useState(false);
  const f = board.format;
  const canStart = board.viewer.isCommissioner && board.scheduleReady && f.teamCount >= 2;
  const queuedIds = new Set(board.me.queue.map((p) => p.id));
  const base = `/leagues/${board.leagueId}`;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Draft format</CardTitle>
          <CardDescription>
            Computed from the league settings and the number of teams. It locks when the draft starts.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4" data-testid="draft-format">
            <Item label="Teams" value={String(f.teamCount)} />
            <Item label="Max roster" value={String(f.maxRoster)} />
            <Item label="Snake rounds" value={`${f.snakeRounds} (${f.snakePicks} picks)`} />
            <Item label="Total picks" value={String(f.totalPicks)} />
          </dl>
          <p className="text-sm">
            <strong>Waves:</strong> {waveBreakdown(f)}. In a wave every team picks at the same time, {f.waveSize} players
            each, first come first served; the next wave opens once everyone has made their picks.
          </p>
          <p className="text-sm text-muted-foreground">No pick timer and no auto-pick: the commissioner can pick for anyone who stalls.</p>

          {board.viewer.isCommissioner && (
            <div className="grid gap-2">
              {!board.scheduleReady && (
                <p role="alert" data-testid="schedule-required" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {f.teamCount < 2 ? "At least 2 teams are needed to start the draft. " : "Generate the schedule first. "}
                  {f.teamCount >= 2 && (
                    <>
                      The schedule must include every team (it resets when teams join or leave).{" "}
                      <Link href={`${base}/schedule`} className="font-medium underline underline-offset-4">
                        Go to the schedule page
                      </Link>
                      .
                    </>
                  )}
                </p>
              )}
              <Button disabled={!canStart || pending} onClick={() => setConfirm(true)} className="w-full sm:w-fit" data-testid="start-draft">
                Start draft
              </Button>
            </div>
          )}
          {!board.viewer.isCommissioner && <p className="text-sm">Waiting for the commissioner to start the draft.</p>}
        </CardContent>
      </Card>

      {f.keepers > 0 && (
        <Card data-testid="keepers-card">
          <CardHeader>
            <CardTitle>Keepers</CardTitle>
            <CardDescription>
              Up to {f.keepers} per team from last season&apos;s roster. Keepers join your roster when the draft starts, so you draft that
              many fewer players.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {board.me.keepers.length > 0 ? (
              <p>
                Your keepers: <strong>{board.me.keepers.map((p) => p.name).join(", ")}</strong>
              </p>
            ) : (
              <p className="text-muted-foreground">You haven&apos;t chosen any keepers.</p>
            )}
            <Link href={`${base}/keepers`} className="w-fit font-medium underline underline-offset-4">
              Choose keepers
            </Link>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Teams</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            {board.teams.map((t) => (
              <li key={t.id} className="flex items-center gap-2">
                <Link href={`${base}/teams/${t.id}`} className="font-medium underline-offset-4 hover:underline">
                  {t.name}
                </Link>
                <span className="text-muted-foreground">{t.ownerUsername}</span>
                {t.id === board.viewer.teamId && <Badge variant="outline">You</Badge>}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {board.viewer.teamId && (
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Build your queue</CardTitle>
              <CardDescription>Ranked by projected fantasy points per game. Your queue is private.</CardDescription>
            </CardHeader>
            <CardContent>
              <PlayerSearch
                leagueId={board.leagueId}
                nbaTeams={nbaTeams}
                actions={(p) =>
                  queuedIds.has(p.id) ? (
                    <Badge variant="secondary">Queued</Badge>
                  ) : (
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => addToQueueAction(board.leagueId, p.id))} data-testid="queue-button">
                      Queue
                    </Button>
                  )
                }
              />
            </CardContent>
          </Card>
          <QueuePanel leagueId={board.leagueId} queue={board.me.queue} canPick={false} actions={actions} />
        </div>
      )}

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start the draft?</DialogTitle>
            <DialogDescription>
              The draft order will be randomized and can&apos;t be changed. Roster size, snake rounds and wave settings lock,
              and teams can no longer be added or removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              disabled={pending}
              data-testid="confirm-start-draft"
              onClick={() => {
                setConfirm(false);
                run(() => startDraftAction(board.leagueId), "Draft started");
              }}
            >
              Start draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
