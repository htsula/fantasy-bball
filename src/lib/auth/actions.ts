"use server";

import { redirect } from "next/navigation";
import { db } from "@/db";
import { authenticate } from "./service";
import { endSession, startSession } from "./session";
import { loginSchema, type FormState } from "./validation";

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = loginSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { username, password } = parsed.data;

  const result = await authenticate(db, username, password);
  if (!result.ok) {
    const error =
      result.reason === "locked"
        ? `Too many failed attempts. Try again in ${Math.ceil(result.retryAfterMs / 60000)} minute(s).`
        : "Invalid username or password.";
    return { error, values: { username } };
  }

  await startSession(result.user.id);
  redirect("/"); // must stay outside try/catch: redirect() throws
}

export async function logoutAction() {
  await endSession();
  redirect("/login");
}
