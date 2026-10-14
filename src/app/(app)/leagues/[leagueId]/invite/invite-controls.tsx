"use client";

import { useActionState, useState, useTransition } from "react";
import { toast } from "sonner";
import { FormError, FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FormState } from "@/lib/auth/validation";
import {
  createLeagueInviteAction,
  removeInvitedTeamAction,
  revokeLeagueInviteAction,
  type InviteActionState,
} from "../../actions";

export function CopyLink({ url, label = "Invite link" }: { url: string; label?: string }) {
  async function copy() {
    await navigator.clipboard.writeText(url);
    toast.success("Link copied");
  }
  return (
    <div className="flex gap-2">
      <Input readOnly value={url} aria-label={label} onFocus={(e) => e.target.select()} />
      <Button type="button" variant="outline" onClick={copy}>
        Copy
      </Button>
    </div>
  );
}

export function CreateInviteForm({ leagueId, hasActive }: { leagueId: string; hasActive: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createLeagueInviteAction.bind(null, leagueId), {});
  return (
    <form action={action} className="grid gap-3">
      <FormError message={state.error} />
      {state.success && <p className="text-sm text-muted-foreground">{state.success}</p>}
      {hasActive && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="revokeOld" defaultChecked className="size-4" />
          Turn off the old link(s) when creating the new one
        </label>
      )}
      <FormField
        name="maxUses"
        label="Maximum teams (optional, blank = unlimited)"
        type="number"
        min={1}
        max={1000}
        errors={state.fieldErrors?.maxUses}
      />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating..." : hasActive ? "Create new link" : "Create invite link"}
        </Button>
      </div>
    </form>
  );
}

function useRun() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  function run(fn: () => Promise<InviteActionState>) {
    setError(undefined);
    start(async () => {
      const res = await fn();
      if (res.error) setError(res.error);
    });
  }
  return { pending, error, run };
}

export function RevokeButton({ leagueId, inviteId }: { leagueId: string; inviteId: string }) {
  const { pending, error, run } = useRun();
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          if (window.confirm("Turn off this link? People who haven't joined yet will no longer be able to use it.")) {
            run(() => revokeLeagueInviteAction(leagueId, inviteId));
          }
        }}
      >
        {pending ? "Revoking..." : "Revoke"}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}

export function RemoveTeamButton({ leagueId, teamId, teamName }: { leagueId: string; teamId: string; teamName: string }) {
  const { pending, error, run } = useRun();
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="destructive"
        disabled={pending}
        onClick={() => {
          if (window.confirm(`Remove team "${teamName}" from the league? The schedule will need to be regenerated.`)) {
            run(() => removeInvitedTeamAction(leagueId, teamId));
          }
        }}
      >
        {pending ? "Removing..." : "Remove team"}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
