"use client";

import { useActionState } from "react";
import { FormError, FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loginAction } from "@/lib/auth/actions";
import type { FormState } from "@/lib/auth/validation";

export function LoginForm({ passwordReset }: { passwordReset: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(loginAction, {});
  return (
    <Card>
      <CardHeader>
        <CardTitle>Log in</CardTitle>
        <CardDescription>
          {passwordReset
            ? "Password updated. Log in with your new password."
            : "Need an account? Ask your league commissioner for an invite link."}
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
            errors={state.fieldErrors?.username}
            required
          />
          <FormField
            name="password"
            label="Password"
            type="password"
            autoComplete="current-password"
            errors={state.fieldErrors?.password}
            required
          />
          <Button type="submit" disabled={pending}>
            {pending ? "Logging in..." : "Log in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
