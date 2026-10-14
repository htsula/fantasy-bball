"use client";

import { useTransition } from "react";
import { useSWRConfig } from "swr";
import { toast } from "sonner";
import type { DraftActionResult } from "@/app/(app)/leagues/[leagueId]/draft/actions";
import { playersKeyPrefix } from "./player-search";

/** Runs a draft server action, toasts the outcome and refreshes the board and player lists. */
export function useDraftActions(leagueId: string, refreshBoard: () => Promise<unknown> | void) {
  const { mutate } = useSWRConfig();
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<DraftActionResult>, success?: string) =>
    startTransition(async () => {
      try {
        const result = await action();
        if (result.ok) {
          if (success) toast.success(success);
        } else {
          toast.error(result.error);
        }
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
      await Promise.all([
        refreshBoard(),
        mutate((key) => typeof key === "string" && key.startsWith(playersKeyPrefix(leagueId))),
      ]);
    });

  return { run, pending };
}
