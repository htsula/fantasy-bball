"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { startNextSeasonAction } from "./actions";

export function NextSeasonButton({ leagueId }: { leagueId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-2">
      <Button
        className="w-fit"
        disabled={pending}
        data-testid="start-next-season"
        onClick={() => {
          setError(null);
          start(async () => {
            const res = await startNextSeasonAction(leagueId);
            if (res.ok || res.leagueId) router.push(`/leagues/${res.leagueId}`);
            else setError(res.error);
          });
        }}
      >
        {pending ? "Starting..." : "Start next season"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
