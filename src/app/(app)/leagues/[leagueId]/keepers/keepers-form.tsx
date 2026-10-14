"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtNum } from "@/lib/nba/format";
import { saveKeepersAction } from "./actions";

export type KeeperCandidate = {
  id: number;
  name: string;
  nbaTeam: string | null;
  positions: string[];
  lastFp: number | null;
  lastAvg: number | null;
};

export function KeepersForm({
  leagueId,
  teamId,
  teamName,
  candidates,
  selected,
  limit,
  locked,
}: {
  leagueId: string;
  teamId: string;
  teamName: string;
  candidates: KeeperCandidate[];
  selected: number[];
  limit: number;
  locked: boolean;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<Set<number>>(new Set(selected));
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const full = picked.size >= limit;

  const toggle = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < limit) next.add(id);
      return next;
    });

  return (
    <form
      className="grid gap-3"
      data-testid="keepers-form"
      aria-label={`Keepers for ${teamName}`}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const res = await saveKeepersAction(leagueId, teamId, [...picked]);
          if (res.ok) {
            toast.success(`Saved ${res.saved} keeper${res.saved === 1 ? "" : "s"}`);
            router.refresh();
          } else setError(res.error);
        });
      }}
    >
      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No eligible players: keepers come from last season&apos;s final roster and must still be active on an NBA roster.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">Keep</TableHead>
                <TableHead>Player</TableHead>
                <TableHead>Team</TableHead>
                <TableHead>Pos</TableHead>
                <TableHead className="text-right">Last FP</TableHead>
                <TableHead className="text-right">Last FP/G</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.map((p) => (
                <TableRow key={p.id} data-testid="keeper-row" data-player-id={p.id}>
                  <TableCell>
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={picked.has(p.id)}
                      disabled={locked || pending || (full && !picked.has(p.id))}
                      onChange={() => toggle(p.id)}
                      aria-label={`Keep ${p.name}`}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell>{p.nbaTeam ?? "-"}</TableCell>
                  <TableCell>{p.positions.join("/") || "-"}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(p.lastFp, 0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(p.lastAvg)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={locked || pending} data-testid="save-keepers">
          {pending ? "Saving..." : "Save keepers"}
        </Button>
        <span className="text-sm text-muted-foreground" data-testid="keeper-count">
          {picked.size} of {limit} selected
        </span>
      </div>
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
