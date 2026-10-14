"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  addFreeAgentAction,
  commissionerAddAction,
  dropPlayerAction,
  restorePlayerAction,
  type RosterActionResult,
} from "@/app/(app)/leagues/[leagueId]/roster-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

export type RosterChoice = { id: number; name: string; detail?: string };

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-xs text-destructive" data-testid="roster-error">
      {message}
    </p>
  );
}

/** Runs a roster action with a pending flag, a toast on success and the error text on failure. */
function useRosterAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<RosterActionResult>, success: string, onOk?: () => void) => {
    setError(null);
    start(async () => {
      const res = await fn();
      if (res.ok) {
        toast.success(success);
        onOk?.();
      } else {
        setError(res.error);
      }
    });
  };
  return { pending, error, setError, run };
}

/** Owner or commissioner drops a player after a confirmation. */
export function DropButton({
  leagueId,
  teamId,
  playerId,
  playerName,
}: {
  leagueId: string;
  teamId: string;
  playerId: number;
  playerName: string;
}) {
  const [open, setOpen] = useState(false);
  const { pending, error, setError, run } = useRosterAction();
  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        data-testid="drop-button"
        aria-label={`Drop ${playerName}`}
      >
        Drop
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Drop {playerName}?</DialogTitle>
            <DialogDescription>
              He becomes a free agent right away. Drops are unlimited, but anyone in the league can add him.
            </DialogDescription>
          </DialogHeader>
          <ErrorLine message={error} />
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              disabled={pending}
              data-testid="confirm-drop"
              onClick={() => run(() => dropPlayerAction(leagueId, teamId, playerId), `Dropped ${playerName}`, () => setOpen(false))}
            >
              {pending ? "Dropping..." : "Drop player"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Adds a free agent to the viewer's team. With a full roster it opens a dialog to pick the player
 * to drop in the same action. Errors (player_taken, daily_limit_reached, ...) show inline.
 */
export function AddPlayerButton({
  leagueId,
  teamId,
  playerId,
  playerName,
  rosterFull,
  roster,
  addsRemaining,
}: {
  leagueId: string;
  teamId: string;
  playerId: number;
  playerName: string;
  rosterFull: boolean;
  roster: RosterChoice[];
  addsRemaining: number;
}) {
  const [open, setOpen] = useState(false);
  const [dropId, setDropId] = useState("");
  const { pending, error, setError, run } = useRosterAction();
  const noAdds = addsRemaining <= 0;

  const add = (drop: number | null) =>
    run(() => addFreeAgentAction(leagueId, teamId, playerId, drop), `Added ${playerName}`, () => setOpen(false));

  return (
    <div className="grid gap-1">
      <Button
        size="xs"
        disabled={pending}
        title={noAdds ? "No adds left today: the server will refuse this until midnight ET" : undefined}
        data-testid="add-button"
        aria-label={`Add ${playerName}`}
        onClick={() => {
          setError(null);
          if (rosterFull) setOpen(true);
          else add(null);
        }}
      >
        {pending && !open ? "Adding..." : "Add"}
      </Button>
      {!open && <ErrorLine message={error} />}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add {playerName}</DialogTitle>
            <DialogDescription>Your roster is full. Choose a player to drop to make room.</DialogDescription>
          </DialogHeader>
          <NativeSelect value={dropId} onChange={(e) => setDropId(e.target.value)} aria-label="Player to drop" data-testid="drop-select">
            <option value="">Choose a player to drop</option>
            {roster.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.detail ? ` (${p.detail})` : ""}
              </option>
            ))}
          </NativeSelect>
          <ErrorLine message={error} />
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button disabled={pending || !dropId} data-testid="confirm-add" onClick={() => add(Number(dropId))}>
              {pending ? "Adding..." : "Add and drop"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type Found = { id: number; name: string; nbaTeam: string | null; positions: string[]; injuryStatus: string | null };

/** Commissioner: search free agents and add one to this team (bypasses the daily limit). */
export function CommissionerAddPlayer({ leagueId, teamId }: { leagueId: string; teamId: string }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Found[] | null>(null);
  const [searching, setSearching] = useState(false);
  const { pending, error, run } = useRosterAction();

  async function search() {
    if (!q.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/leagues/${leagueId}/draft/players?q=${encodeURIComponent(q.trim())}&size=8`, { cache: "no-store" });
      const data = (await res.json()) as { players?: Found[] };
      setResults(data.players ?? []);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="grid gap-3" data-testid="commissioner-add">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search free agents" aria-label="Search free agents" />
        <Button type="submit" variant="outline" disabled={searching}>
          Search
        </Button>
      </form>
      <ErrorLine message={error} />
      {results && results.length === 0 && <p className="text-sm text-muted-foreground">No free agents match.</p>}
      {results && results.length > 0 && (
        <ul className="grid gap-1">
          {results.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-sm">
              <span>
                {p.name} <span className="text-muted-foreground">{p.nbaTeam ?? "FA"} {p.positions.join("/")}</span>
              </span>
              <Button
                size="xs"
                disabled={pending}
                aria-label={`Commissioner add ${p.name}`}
                onClick={() =>
                  run(() => commissionerAddAction(leagueId, teamId, p.id), `Added ${p.name}`, () =>
                    setResults((r) => r?.filter((x) => x.id !== p.id) ?? null),
                  )
                }
              >
                Add
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Commissioner: undo an auto-drop from the transactions feed. */
export function RestoreButton({ leagueId, transactionId, playerName }: { leagueId: string; transactionId: string; playerName: string }) {
  const { pending, error, run } = useRosterAction();
  return (
    <span className="inline-grid gap-1">
      <Button
        size="xs"
        variant="outline"
        disabled={pending}
        aria-label={`Restore ${playerName}`}
        onClick={() => run(() => restorePlayerAction(leagueId, transactionId), `Restored ${playerName}`)}
      >
        Restore
      </Button>
      <ErrorLine message={error} />
    </span>
  );
}
