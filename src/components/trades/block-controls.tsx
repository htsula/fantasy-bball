"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { addToBlockAction, removeFromBlockAction, type TradeActionResult } from "@/app/(app)/leagues/[leagueId]/trades/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

function useBlockAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<TradeActionResult>, success: string, onOk?: () => void) => {
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

/** Owner: list a player on the trade block (team page) or take him off. */
export function BlockToggle({
  leagueId,
  teamId,
  playerId,
  playerName,
  onBlock,
}: {
  leagueId: string;
  teamId: string;
  playerId: number;
  playerName: string;
  onBlock: boolean;
}) {
  const { pending, error, run } = useBlockAction();
  return (
    <span className="inline-grid gap-1">
      <Button
        variant="ghost"
        size="xs"
        disabled={pending}
        data-testid={onBlock ? "unblock-button" : "block-button"}
        aria-label={onBlock ? `Remove ${playerName} from the trade block` : `Put ${playerName} on the trade block`}
        onClick={() =>
          onBlock
            ? run(() => removeFromBlockAction(leagueId, teamId, playerId), `${playerName} is off the block`)
            : run(() => addToBlockAction(leagueId, teamId, playerId), `${playerName} is on the block`)
        }
      >
        {onBlock ? "Unblock" : "Block"}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}

/** Trade block page: pick one of my players and add him with a note. */
export function BlockAddForm({
  leagueId,
  teamId,
  candidates,
}: {
  leagueId: string;
  teamId: string;
  candidates: { id: number; name: string }[];
}) {
  const [playerId, setPlayerId] = useState("");
  const [note, setNote] = useState("");
  const { pending, error, run } = useBlockAction();
  if (candidates.length === 0) return <p className="text-sm text-muted-foreground">All of your players are already on the block.</p>;
  return (
    <form
      className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
      onSubmit={(e) => {
        e.preventDefault();
        if (!playerId) return;
        run(() => addToBlockAction(leagueId, teamId, Number(playerId), note.trim() || undefined), "Added to the trade block", () => {
          setPlayerId("");
          setNote("");
        });
      }}
    >
      <NativeSelect value={playerId} onChange={(e) => setPlayerId(e.target.value)} aria-label="Player to list" data-testid="block-player-select">
        <option value="">Choose a player</option>
        {candidates.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </NativeSelect>
      <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Note (what are you looking for?)" aria-label="Note" />
      <Button type="submit" disabled={pending || !playerId} data-testid="block-add">
        Add to block
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive sm:col-span-3">
          {error}
        </p>
      )}
    </form>
  );
}
