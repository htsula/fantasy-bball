/** League settings: zod schema, defaults and plain-language helpers. Pure (no DB). */
import { z } from "zod";
import { isEtDateString } from "@/lib/nba/dates";
import { DEFAULT_POINTS, STAT_KEYS, type PointValues } from "./points";

/** Scoring values: ESPN defaults plus the house +4 team-win bonus (applied from milestone 6). */
export const DEFAULT_TEAM_WIN_BONUS = 4;

export const SCORING_KEYS = [...STAT_KEYS, "teamWin"] as const;
export type ScoringKey = (typeof SCORING_KEYS)[number];
export type ScoringValues = PointValues & { teamWin: number };

export const SCORING_LABELS: Record<ScoringKey, string> = {
  pts: "Point",
  reb: "Rebound",
  ast: "Assist",
  stl: "Steal",
  blk: "Block",
  to: "Turnover",
  fgm: "Field goal made",
  fga: "Field goal attempted",
  ftm: "Free throw made",
  fta: "Free throw attempted",
  tpm: "3-pointer made",
  teamWin: "Team win bonus",
};

export const DEFAULT_SCORING: ScoringValues = { ...DEFAULT_POINTS, teamWin: DEFAULT_TEAM_WIN_BONUS };

export const TRADE_REVIEW_MODES = ["none", "commissioner", "league_vote"] as const;
export type TradeReviewMode = (typeof TRADE_REVIEW_MODES)[number];
export const PLAYOFF_TEAM_OPTIONS = [2, 4, 6, 8] as const;

/** Fields that are frozen once the league leaves "setup" (the draft depends on them). */
export const DRAFT_LOCKED_FIELDS = ["rosterPool", "rosterCap", "snakeTarget", "waveSize", "keepers"] as const;

const dateField = z
  .string()
  .refine((s) => isEtDateString(s), "Enter a valid date (YYYY-MM-DD)")
  .nullable();

const scoringValue = z.number("Enter a number").min(-100, "Too low").max(100, "Too high");

export const scoringSchema = z.object(
  Object.fromEntries(SCORING_KEYS.map((k) => [k, scoringValue])) as Record<ScoringKey, typeof scoringValue>,
);

const int = (min: number, max: number) => z.number("Enter a whole number").int("Enter a whole number").min(min, `Minimum is ${min}`).max(max, `Maximum is ${max}`);

export const leagueSettingsSchema = z
  .object({
    scoring: scoringSchema.default(DEFAULT_SCORING),
    rosterPool: int(1, 5000).default(520),
    rosterCap: int(1, 200).default(50),
    snakeTarget: int(0, 1000).default(200),
    waveSize: int(1, 10).default(2),
    addsPerDay: int(0, 20).default(2),
    tradeReview: z.enum(TRADE_REVIEW_MODES).default("commissioner"),
    tradeReviewHours: int(0, 168).default(24),
    vetoVotesNeeded: int(1, 20).default(4),
    tradeDeadline: dateField.default(null),
    /** First/last regular-season dates (ET). null = unknown (derived from the NBA schedule when possible). */
    regularSeasonStart: dateField.default(null),
    regularSeasonEnd: dateField.default(null),
    matchupPeriod: z.literal("weekly").default("weekly"),
    playoffTeams: z
      .number("Enter a number")
      .refine((n) => (PLAYOFF_TEAM_OPTIONS as readonly number[]).includes(n), "Choose 2, 4, 6 or 8")
      .default(4),
    playoffRoundLength: z
      .number("Enter a number")
      .refine((n) => n === 1 || n === 2, "Choose 1 or 2")
      .default(1),
    keepers: int(0, 20).default(0),
    /** Last ET day owners may change their keepers (the commissioner can always edit). null = no deadline. */
    keeperDeadline: dateField.default(null),
  })
  .refine((s) => !s.regularSeasonStart || !s.regularSeasonEnd || s.regularSeasonEnd >= s.regularSeasonStart, {
    message: "Season end must be on or after the start",
    path: ["regularSeasonEnd"],
  });

export type LeagueSettings = z.infer<typeof leagueSettingsSchema>;

export function defaultSettings(overrides: Partial<LeagueSettings> = {}): LeagueSettings {
  return leagueSettingsSchema.parse({ ...overrides });
}

/** Reads stored jsonb, filling any fields added after the row was written. */
export function parseStoredSettings(raw: unknown): LeagueSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const scoring = { ...DEFAULT_SCORING, ...((r.scoring as object | undefined) ?? {}) };
  return leagueSettingsSchema.parse({ ...r, scoring });
}

/** zod issues -> { "scoring.pts": ["..."] } for form display. */
export function zodFieldErrors(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

export const teamNameSchema = z
  .string()
  .trim()
  .min(2, "Team name must be at least 2 characters")
  .max(30, "Team name must be at most 30 characters");

export const teamAbbrevSchema = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2,4}$/, "Abbreviation must be 2-4 letters"));

export const leagueNameSchema = z
  .string()
  .trim()
  .min(2, "League name must be at least 2 characters")
  .max(60, "League name must be at most 60 characters");

export const seasonSchema = z.coerce.number("Enter a season year").int().min(2000, "Invalid season").max(2100, "Invalid season");
