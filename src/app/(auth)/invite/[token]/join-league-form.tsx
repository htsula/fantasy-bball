"use client";

import { useActionState } from "react";
import { FormError, FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { FormState } from "@/lib/auth/validation";
import { joinLeagueAction } from "@/app/(app)/leagues/actions";

/** Shown to an already-signed-in user who opens a league invite: no new account, just a new team. */
export function JoinLeagueForm({ token, leagueName, username }: { token: string; leagueName: string; username: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(joinLeagueAction.bind(null, token), {});
  const errs = state.fieldErrors;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Join {leagueName} as a new team</CardTitle>
        <CardDescription>You&apos;re signed in as {username}. Name your team to join the league.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="grid gap-4">
          <FormError message={state.error} />
          <FormField name="teamName" label="Team name" defaultValue={state.values?.teamName} errors={errs?.teamName} required />
          <FormField
            name="teamAbbrev"
            label="Team abbreviation (2-4 letters)"
            defaultValue={state.values?.teamAbbrev}
            errors={errs?.teamAbbrev}
            maxLength={4}
            autoCapitalize="characters"
            required
          />
          <Button type="submit" disabled={pending}>
            {pending ? "Joining..." : "Join league"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
