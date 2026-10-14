"use client";

import { useActionState } from "react";
import { FormError, FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import type { FormState } from "@/lib/auth/validation";
import { createLeagueAction } from "../actions";

export function CreateLeagueForm({ defaultSeason }: { defaultSeason: number }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createLeagueAction, {});
  const errs = state.fieldErrors;
  const v = state.values;
  return (
    <form action={action} className="grid gap-4">
      <FormError message={state.error} />
      <FormField name="name" label="League name" defaultValue={v?.name} errors={errs?.name} required />
      <FormField
        name="season"
        label="Season (the year it ends, e.g. 2027 for 2026-27)"
        type="number"
        inputMode="numeric"
        defaultValue={v?.season ?? defaultSeason}
        errors={errs?.season}
        required
      />
      <fieldset className="grid gap-4 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">Your team (you are the commissioner)</legend>
        <FormField name="teamName" label="Team name" defaultValue={v?.teamName} errors={errs?.teamName} required />
        <FormField
          name="teamAbbrev"
          label="Abbreviation (2-4 letters)"
          defaultValue={v?.teamAbbrev}
          errors={errs?.teamAbbrev}
          maxLength={4}
          autoCapitalize="characters"
          required
        />
      </fieldset>
      <Button type="submit" disabled={pending}>
        {pending ? "Creating..." : "Create league"}
      </Button>
    </form>
  );
}
