"use client";

import { useActionState } from "react";
import { FormError, FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { FormState } from "@/lib/auth/validation";
import { redeemInviteAction } from "./actions";

export function InviteForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    redeemInviteAction.bind(null, token),
    {},
  );
  const errs = state.fieldErrors;
  return (
    <Card>
      <CardHeader>
        <CardTitle>You&apos;re invited</CardTitle>
        <CardDescription>Pick a username and password to create your account.</CardDescription>
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
            name="displayName"
            label="Display name"
            autoComplete="name"
            defaultValue={state.values?.displayName}
            errors={errs?.displayName}
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
          <Button type="submit" disabled={pending}>
            {pending ? "Creating account..." : "Create account"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
