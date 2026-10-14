"use server";

import { redirect } from "next/navigation";
import { db } from "@/db";
import { AuthError, redeemInvite } from "@/lib/auth/service";
import { startSession } from "@/lib/auth/session";
import { inviteRedeemSchema, type FormState } from "@/lib/auth/validation";
import { teamAbbrevSchema, teamNameSchema } from "@/lib/fantasy/settings";
import { leagueFormError } from "@/lib/leagues/form-state";
import { getLeagueInviteInfo, redeemLeagueInvite } from "@/lib/leagues/service";

export async function redeemInviteAction(
  token: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = Object.fromEntries(formData) as Record<string, string>;
  const info = await getLeagueInviteInfo(db, token);
  const isLeagueInvite = info.status === "valid" && info.league !== null;
  const values = {
    username: raw.username ?? "",
    ...(isLeagueInvite ? { teamName: raw.teamName ?? "", teamAbbrev: raw.teamAbbrev ?? "" } : {}),
  };

  const parsed = inviteRedeemSchema.safeParse(raw);
  const fieldErrors: Record<string, string[] | undefined> = parsed.success ? {} : parsed.error.flatten().fieldErrors;
  if (isLeagueInvite) {
    const name = teamNameSchema.safeParse(raw.teamName ?? "");
    const abbrev = teamAbbrevSchema.safeParse(raw.teamAbbrev ?? "");
    if (!name.success) fieldErrors.teamName = name.error.issues.map((i) => i.message);
    if (!abbrev.success) fieldErrors.teamAbbrev = abbrev.error.issues.map((i) => i.message);
  }
  if (!parsed.success || Object.keys(fieldErrors).length > 0) return { fieldErrors, values };

  let userId: string;
  let next = "/";
  try {
    if (isLeagueInvite) {
      // New user + their team are created in one transaction.
      const res = await redeemLeagueInvite(db, {
        token,
        username: parsed.data.username,
        password: parsed.data.password,
        teamName: raw.teamName,
        teamAbbrev: raw.teamAbbrev,
      });
      userId = res.user.id;
      next = `/leagues/${res.leagueId}`;
    } else {
      const user = await redeemInvite(db, { token, ...parsed.data });
      userId = user.id;
    }
  } catch (err) {
    if (err instanceof AuthError) {
      return err.code === "username_taken"
        ? { fieldErrors: { username: ["That username is taken"] }, values }
        : { error: "This invite link is no longer valid.", values };
    }
    return leagueFormError(err, values);
  }

  await startSession(userId);
  redirect(next);
}
