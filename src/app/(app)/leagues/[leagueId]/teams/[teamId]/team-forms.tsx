"use client";

import { useActionState } from "react";
import { FormError, FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import type { FormState } from "@/lib/auth/validation";
import { renameTeamAction } from "../../../actions";

export function RenameTeamForm({
  leagueId,
  teamId,
  name,
  abbrev,
}: {
  leagueId: string;
  teamId: string;
  name: string;
  abbrev: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    renameTeamAction.bind(null, leagueId, teamId),
    {},
  );
  const errs = state.fieldErrors;
  return (
    <form action={action} className="grid gap-3">
      <FormError message={state.error} />
      {state.success && (
        <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">
          {state.success}
        </p>
      )}
      <FormField name="teamName" label="Team name" defaultValue={state.values?.teamName ?? name} errors={errs?.teamName} required />
      <FormField
        name="teamAbbrev"
        label="Abbreviation (2-4 letters)"
        defaultValue={state.values?.teamAbbrev ?? abbrev}
        errors={errs?.teamAbbrev}
        maxLength={4}
        required
      />
      <Button type="submit" disabled={pending} className="w-full sm:w-fit">
        {pending ? "Saving..." : "Save team"}
      </Button>
    </form>
  );
}
