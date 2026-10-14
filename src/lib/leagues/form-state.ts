import type { FormState } from "@/lib/auth/validation";
import { LeagueError } from "./service";

/** Turns a LeagueError into form state; unknown errors are rethrown. */
export function leagueFormError(err: unknown, values?: Record<string, string>): FormState {
  if (err instanceof LeagueError) {
    return {
      error: err.fieldErrors ? undefined : err.message,
      fieldErrors: err.fieldErrors,
      values,
    };
  }
  throw err;
}

/** Plain string fields of a submitted form (never includes files or passwords). */
export function stringValues(formData: FormData, skip: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of formData.entries()) {
    if (typeof v === "string" && !skip.includes(k) && !k.startsWith("$ACTION")) out[k] = v;
  }
  return out;
}
