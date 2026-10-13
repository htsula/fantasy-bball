"use client";

import { useActionState } from "react";
import { FormError, FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { FormState } from "@/lib/auth/validation";
import { resetPasswordAction } from "./actions";

export function ResetForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    resetPasswordAction.bind(null, token),
    {},
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Set a new password</CardTitle>
        <CardDescription>You&apos;ll be signed out of all devices.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="grid gap-4">
          <FormError message={state.error} />
          <FormField
            name="password"
            label="New password (min 8 characters)"
            type="password"
            autoComplete="new-password"
            errors={state.fieldErrors?.password}
            required
          />
          <FormField
            name="confirmPassword"
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            errors={state.fieldErrors?.confirmPassword}
            required
          />
          <Button type="submit" disabled={pending}>
            {pending ? "Saving..." : "Set password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
