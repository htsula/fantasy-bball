"use server";

import { redirect } from "next/navigation";
import { db } from "@/db";
import { AuthError, redeemInvite } from "@/lib/auth/service";
import { startSession } from "@/lib/auth/session";
import { inviteRedeemSchema, type FormState } from "@/lib/auth/validation";

export async function redeemInviteAction(
  token: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = Object.fromEntries(formData) as Record<string, string>;
  const values = { username: raw.username ?? "" };
  const parsed = inviteRedeemSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors, values };
  }

  let userId: string;
  try {
    const user = await redeemInvite(db, { token, ...parsed.data });
    userId = user.id;
  } catch (err) {
    if (err instanceof AuthError) {
      return err.code === "username_taken"
        ? { fieldErrors: { username: ["That username is taken"] }, values }
        : { error: "This invite link is no longer valid.", values };
    }
    throw err;
  }

  await startSession(userId);
  redirect("/");
}
