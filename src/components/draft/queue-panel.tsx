"use client";

import { ArrowDown, ArrowUp, X } from "lucide-react";
import { InjuryBadge } from "@/components/nba/injury-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  makePickAction,
  removeFromQueueAction,
  reorderQueueAction,
} from "@/app/(app)/leagues/[leagueId]/draft/actions";
import type { BoardPlayer } from "@/lib/draft/board";
import { fmtNum } from "@/lib/nba/format";
import type { useDraftActions } from "./use-draft-actions";

/** My queue: reorder with up/down, remove, and (when it's my pick) draft the top player. */
export function QueuePanel({
  leagueId,
  queue,
  canPick,
  actions,
}: {
  leagueId: string;
  queue: BoardPlayer[];
  canPick: boolean;
  actions: ReturnType<typeof useDraftActions>;
}) {
  const { run, pending } = actions;
  const move = (index: number, delta: -1 | 1) => {
    const next = queue.map((p) => p.id);
    const j = index + delta;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    run(() => reorderQueueAction(leagueId, next));
  };

  return (
    <Card size="sm" data-testid="queue-panel">
      <CardHeader>
        <CardTitle>My queue</CardTitle>
        <CardDescription>
          Drafted players drop out automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {canPick && queue.length > 0 && (
          <Button
            disabled={pending}
            onClick={() => run(() => makePickAction(leagueId, queue[0].id), `Drafted ${queue[0].name}`)}
            data-testid="draft-top-of-queue"
          >
            Draft top of queue: {queue[0].name}
          </Button>
        )}
        {queue.length === 0 ? (
          <p className="text-sm text-muted-foreground">Queue players with the Queue button to line up your picks.</p>
        ) : (
          <ol className="grid gap-1">
            {queue.map((p, i) => (
              <li key={p.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm" data-testid="queue-item">
                <span className="w-5 text-muted-foreground tabular-nums">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1 font-medium">
                    <span className="truncate">{p.name}</span>
                    <InjuryBadge status={p.injuryStatus} detail={p.injuryDetail} />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {p.positions.join("/") || "-"} · {p.nbaTeam ?? "-"} · Last FP {fmtNum(p.lastFp, 0)} ({fmtNum(p.lastAvg)}/G) · Proj {fmtNum(p.proj)}
                  </div>
                </div>
                <Button variant="ghost" size="icon-sm" aria-label={`Move ${p.name} up`} disabled={pending || i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${p.name} down`}
                  disabled={pending || i === queue.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${p.name} from queue`}
                  disabled={pending}
                  onClick={() => run(() => removeFromQueueAction(leagueId, p.id))}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
