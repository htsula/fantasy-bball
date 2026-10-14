"use client";

import { useActionState } from "react";
import { FormError, FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { FormState } from "@/lib/auth/validation";
import { redeemInviteAction } from "./actions";

export function InviteForm({ token, leagueName }: { token: string; leagueName?: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    redeemInviteAction.bind(null, token),
    {},
  );
  const errs = state.fieldErrors;
  return (
    <Card>
      <CardHeader>
        <CardTitle>You&apos;re invited</CardTitle>
        <CardDescription>
          {leagueName
            ? `Create your account and name your team to join ${leagueName}.`
            : "Pick a username and password to create your account."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="grid gap-4">
          <FormError message={state.error} />
          <FormField
            name="username"
            label="Username"
            autoComplete="username"
            autoCapitalize="none"
            defaultValue={state.values?.username}
            errors={errs?.username}
            required
          />
          <FormField
            name="password"
            label="Password (min 8 characters)"
            type="password"
            autoComplete="new-password"
            errors={errs?.password}
            required
          />
          <FormField
            name="confirmPassword"
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            errors={errs?.confirmPassword}
            required
          />
          {leagueName && (
            <fieldset className="grid gap-4 rounded-lg border p-3">
              <legend className="px-1 text-sm font-medium">Your team in {leagueName}</legend>
              <FormField
                name="teamName"
                label="Team name"
                defaultValue={state.values?.teamName}
                errors={errs?.teamName}
                required
              />
              <FormField
                name="teamAbbrev"
                label="Team abbreviation (2-4 letters)"
                defaultValue={state.values?.teamAbbrev}
                errors={errs?.teamAbbrev}
                maxLength={4}
                autoCapitalize="characters"
                required
              />
            </fieldset>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Creating account..." : "Create account"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
