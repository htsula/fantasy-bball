"use server";

import { redirect } from "next/navigation";
import { db } from "@/db";
import { AuthError, redeemPasswordReset } from "@/lib/auth/service";
import { newPasswordSchema, type FormState } from "@/lib/auth/validation";

export async function resetPasswordAction(
  token: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = newPasswordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    // Also deletes every existing session for that user.
    await redeemPasswordReset(db, { token, password: parsed.data.password });
  } catch (err) {
    if (err instanceof AuthError) return { error: "This reset link is no longer valid." };
    throw err;
  }
  redirect("/login?reset=1");
}
