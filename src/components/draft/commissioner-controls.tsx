"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { makePickAction, undoLastPickAction } from "@/app/(app)/leagues/[leagueId]/draft/actions";
import type { DraftBoard } from "@/lib/draft/board";
import { PlayerSearch } from "./player-search";
import type { useDraftActions } from "./use-draft-actions";

/** Commissioner-only: pick for a team that is on the clock / still owes wave picks, or undo. */
export function CommissionerControls({
  board,
  nbaTeams,
  actions,
}: {
  board: DraftBoard;
  nbaTeams: { id: number; abbrev: string }[];
  actions: ReturnType<typeof useDraftActions>;
}) {
  const { run, pending } = actions;
  const draft = board.draft!;
  const [teamId, setTeamId] = useState("");
  const [confirmUndo, setConfirmUndo] = useState(false);
  const active = draft.status === "snake" || draft.status === "waves";

  const eligible = new Map<string, string>();
  if (draft.onClock) eligible.set(draft.onClock.teamId, "on the clock");
  if (draft.wave) for (const w of draft.wave.waiting) eligible.set(w.teamId, `${w.remaining} left`);
  const teamName = (id: string) => board.teams.find((t) => t.id === id)?.name ?? "team";
  const selected = eligible.has(teamId) ? teamId : "";

  return (
    <Card size="sm" data-testid="commissioner-controls">
      <CardHeader>
        <CardTitle>Commissioner controls</CardTitle>
        <CardDescription>Pick for a team that is stalling, or undo the most recent pick.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {active && (
          <details className="group rounded-md border p-2" data-testid="pick-for-team">
            <summary className="cursor-pointer text-sm font-medium">Pick for team...</summary>
            <div className="mt-3 grid gap-3">
              <NativeSelect value={selected} onChange={(e) => setTeamId(e.target.value)} aria-label="Team to pick for">
                <option value="">Choose a team</option>
                {[...eligible].map(([id, why]) => (
                  <option key={id} value={id}>
                    {teamName(id)} ({why})
                  </option>
                ))}
              </NativeSelect>
              <PlayerSearch
                leagueId={board.leagueId}
                nbaTeams={nbaTeams}
                compact
                takenIds={new Set(draft.picks.map((p) => p.player.id))}
                pageSize={5}
                refreshMs={0}
                actions={(p) => (
                  <Button
                    size="sm"
                    disabled={pending || !selected}
                    data-testid="commissioner-pick-button"
                    onClick={() =>
                      run(() => makePickAction(board.leagueId, p.id, selected), `Drafted ${p.name} for ${teamName(selected)}`)
                    }
                  >
                    Pick
                  </Button>
                )}
              />
            </div>
          </details>
        )}

        <div>
          <Button
            variant="destructive"
            disabled={pending || draft.picks.length === 0}
            onClick={() => setConfirmUndo(true)}
            data-testid="undo-button"
          >
            Undo last pick
          </Button>
        </div>
      </CardContent>

      <Dialog open={confirmUndo} onOpenChange={setConfirmUndo}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Undo the last pick?</DialogTitle>
            <DialogDescription>
              {draft.recent[0]
                ? `This removes ${draft.recent[0].player.name} (pick #${draft.recent[0].overall}) from ${teamName(draft.recent[0].teamId)} and puts the draft back where it was.`
                : "Nothing to undo."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              disabled={pending}
              data-testid="confirm-undo"
              onClick={() => {
                setConfirmUndo(false);
                run(() => undoLastPickAction(board.leagueId), "Last pick undone");
              }}
            >
              Undo pick
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
