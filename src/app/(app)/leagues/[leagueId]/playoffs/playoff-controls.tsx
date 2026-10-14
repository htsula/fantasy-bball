"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { overrideWinnerAction, reseedPlayoffsAction, type PlayoffActionResult } from "./actions";

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<PlayoffActionResult>, success: string, onOk?: () => void) => {
    setError(null);
    start(async () => {
      const res = await fn();
      if (res.ok) {
        toast.success(success);
        onOk?.();
        router.refresh();
      } else setError(res.error);
    });
  };
  return { pending, error, run };
}

/** Commissioner: rebuild the bracket from the current standings (only before round 1 starts). */
export function ReseedButton({ leagueId }: { leagueId: string }) {
  const { pending, error, run } = useRun();
  return (
    <div className="grid gap-2">
      <Button
        variant="outline"
        className="w-fit"
        disabled={pending}
        data-testid="reseed-button"
        onClick={() => {
          if (window.confirm("Re-seed the playoffs from the current standings? This rebuilds the whole bracket.")) {
            run(() => reseedPlayoffsAction(leagueId), "Playoffs re-seeded");
          }
        }}
      >
        Re-seed playoffs
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Commissioner: set the winner of one game by hand (data problems). Logged on the bracket. */
export function OverrideWinner({
  leagueId,
  slotId,
  teams,
}: {
  leagueId: string;
  slotId: string;
  teams: { teamId: string; name: string }[];
}) {
  const [note, setNote] = useState("");
  const { pending, error, run } = useRun();
  return (
    <details className="text-xs" data-testid="override-winner">
      <summary className="cursor-pointer text-muted-foreground underline-offset-4 hover:underline">Set winner manually</summary>
      <div className="mt-2 grid gap-2">
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Reason (shown on the bracket)" aria-label="Reason" />
        <div className="flex flex-wrap gap-2">
          {teams.map((t) => (
            <Button
              key={t.teamId}
              size="xs"
              variant="outline"
              disabled={pending}
              onClick={() => run(() => overrideWinnerAction(leagueId, slotId, t.teamId, note), `${t.name} advances`)}
            >
              {t.name} wins
            </Button>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
