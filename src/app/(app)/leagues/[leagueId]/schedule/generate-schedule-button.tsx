"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { generateScheduleAction, type ScheduleState } from "../../actions";

export function GenerateScheduleButton({ leagueId, hasSchedule }: { leagueId: string; hasSchedule: boolean }) {
  const [state, action, pending] = useActionState<ScheduleState, FormData>(
    generateScheduleAction.bind(null, leagueId),
    {},
  );
  return (
    <form action={action} className="grid gap-2">
      <Button type="submit" disabled={pending} className="w-full sm:w-fit">
        {pending ? "Generating..." : hasSchedule ? "Regenerate schedule" : "Generate schedule"}
      </Button>
      {hasSchedule && (
        <p className="text-xs text-muted-foreground">Regenerating replaces all matchups (random pairings each time).</p>
      )}
      {state.error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state.success && (
        <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">
          {state.success}
        </p>
      )}
      {state.notices?.map((n) => (
        <p key={n} className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          Note: {n}
        </p>
      ))}
    </form>
  );
}
