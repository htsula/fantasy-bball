"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { baseUrl } from "@/lib/app-url";
import { requireUser } from "@/lib/auth/session";
import type { FormState } from "@/lib/auth/validation";
import { SCORING_KEYS } from "@/lib/fantasy/settings";
import { leagueFormError, stringValues } from "@/lib/leagues/form-state";
import {
  LeagueError,
  createLeague,
  createLeagueInvite,
  generateSchedule,
  joinLeague,
  removeTeam,
  renameTeam,
  updateSettings,
} from "@/lib/leagues/service";
import type { LinkState } from "../admin/actions";

const str = (formData: FormData, key: string) => String(formData.get(key) ?? "");

export async function createLeagueAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const values = stringValues(formData);
  let leagueId: string;
  try {
    const league = await createLeague(db, user, {
      name: str(formData, "name"),
      season: str(formData, "season"),
      teamName: str(formData, "teamName"),
      teamAbbrev: str(formData, "teamAbbrev"),
    });
    leagueId = league.id;
  } catch (err) {
    return leagueFormError(err, values);
  }
  redirect(`/leagues/${leagueId}`);
}

const INT_FIELDS = [
  "rosterPool",
  "rosterCap",
  "snakeTarget",
  "waveSize",
  "addsPerDay",
  "tradeReviewHours",
  "vetoVotesNeeded",
  "playoffTeams",
  "playoffRoundLength",
  "keepers",
] as const;
const DATE_FIELDS = ["tradeDeadline", "regularSeasonStart", "regularSeasonEnd"] as const;

const num = (v: FormDataEntryValue) => (String(v).trim() === "" ? NaN : Number(v));

/** Builds a settings patch from the form. Disabled (locked) inputs aren't submitted, so they're skipped. */
function settingsPatch(formData: FormData) {
  const patch: Record<string, unknown> = {};
  const scoring: Record<string, number> = {};
  for (const key of SCORING_KEYS) {
    const v = formData.get(`scoring.${key}`);
    if (v !== null) scoring[key] = num(v);
  }
  if (Object.keys(scoring).length) patch.scoring = scoring;
  for (const key of INT_FIELDS) {
    const v = formData.get(key);
    if (v !== null) patch[key] = num(v);
  }
  for (const key of DATE_FIELDS) {
    const v = formData.get(key);
    if (v !== null) patch[key] = String(v).trim() === "" ? null : String(v).trim();
  }
  const review = formData.get("tradeReview");
  if (review !== null) patch.tradeReview = String(review);
  return patch;
}

export async function updateSettingsAction(leagueId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const values = stringValues(formData);
  try {
    await updateSettings(db, user, leagueId, settingsPatch(formData));
  } catch (err) {
    return leagueFormError(err, values);
  }
  revalidatePath(`/leagues/${leagueId}`, "layout");
  return { success: "Settings saved.", values };
}

export async function createLeagueInviteAction(leagueId: string): Promise<LinkState> {
  const user = await requireUser();
  try {
    const { token, expiresAt } = await createLeagueInvite(db, user, leagueId);
    revalidatePath(`/leagues/${leagueId}/invite`);
    return { url: `${await baseUrl()}/invite/${token}`, expiresAt: expiresAt.toISOString() };
  } catch (err) {
    if (err instanceof LeagueError) return { error: err.message };
    throw err;
  }
}

export async function joinLeagueAction(token: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const values = stringValues(formData);
  let leagueId: string;
  try {
    const team = await joinLeague(db, user, {
      token,
      teamName: str(formData, "teamName"),
      teamAbbrev: str(formData, "teamAbbrev"),
    });
    leagueId = team.leagueId;
  } catch (err) {
    return leagueFormError(err, values);
  }
  redirect(`/leagues/${leagueId}`);
}

export type ScheduleState = { error?: string; success?: string; notices?: string[] };

export async function generateScheduleAction(leagueId: string): Promise<ScheduleState> {
  const user = await requireUser();
  try {
    const r = await generateSchedule(db, user, leagueId);
    revalidatePath(`/leagues/${leagueId}`, "layout");
    return {
      success: `Schedule generated: ${r.regularPeriods} regular-season periods and ${r.playoffPeriods} playoff periods.`,
      notices: r.notices,
    };
  } catch (err) {
    if (err instanceof LeagueError) return { error: err.message };
    throw err;
  }
}

export async function renameTeamAction(
  leagueId: string,
  teamId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const values = stringValues(formData);
  try {
    await renameTeam(db, user, teamId, { name: str(formData, "teamName"), abbrev: str(formData, "teamAbbrev") });
  } catch (err) {
    return leagueFormError(err, values);
  }
  revalidatePath(`/leagues/${leagueId}`, "layout");
  return { success: "Team updated.", values };
}

export async function removeTeamAction(leagueId: string, teamId: string): Promise<void> {
  const user = await requireUser();
  try {
    await removeTeam(db, user, teamId);
  } catch (err) {
    if (!(err instanceof LeagueError)) throw err;
    redirect(`/leagues/${leagueId}/teams/${teamId}?error=${encodeURIComponent(err.message)}`);
  }
  revalidatePath(`/leagues/${leagueId}`, "layout");
  redirect(`/leagues/${leagueId}`);
}
