/**
 * Minimal, loose zod schemas for just the ESPN fields we read. Everything is optional and
 * unknown keys pass through, so ESPN adding fields is harmless; if the shape drifts enough to
 * fail validation we log a warning and carry on with the raw data (normalizers are defensive).
 */
import { z } from "zod";

const idLike = z.union([z.string(), z.number()]);
const numLike = z.union([z.string(), z.number()]);
const str = z.string();

const logoSchema = z.looseObject({ href: str.optional() });

export const teamSchema = z.looseObject({
  id: idLike.optional(),
  abbreviation: str.optional(),
  displayName: str.optional(),
  name: str.optional(),
  location: str.optional(),
  color: str.optional(),
  logo: str.optional(),
  logos: z.array(logoSchema).optional(),
});

export const teamsResponseSchema = z.looseObject({
  sports: z
    .array(
      z.looseObject({
        leagues: z
          .array(z.looseObject({ teams: z.array(z.looseObject({ team: teamSchema.optional() })).optional() }))
          .optional(),
      }),
    )
    .optional(),
});

const athleteSchema = z.looseObject({
  id: idLike.optional(),
  firstName: str.optional(),
  lastName: str.optional(),
  fullName: str.optional(),
  displayName: str.optional(),
  shortName: str.optional(),
  jersey: str.optional(),
  age: numLike.optional(),
  weight: numLike.optional(),
  height: numLike.optional(),
  dateOfBirth: str.optional(),
  experience: z.looseObject({ years: numLike.optional() }).optional(),
  position: z.looseObject({ abbreviation: str.optional(), name: str.optional() }).optional(),
  headshot: z.looseObject({ href: str.optional() }).optional(),
  status: z.looseObject({ type: str.optional(), name: str.optional() }).optional(),
});

export const rosterResponseSchema = z.looseObject({
  team: teamSchema.optional(),
  // Flat list of athletes, or (older shape) groups with `items`.
  athletes: z.array(athleteSchema.extend({ items: z.array(athleteSchema).optional() })).optional(),
});

const statusSchema = z.looseObject({
  clock: numLike.optional(),
  displayClock: str.optional(),
  period: numLike.optional(),
  type: z
    .looseObject({
      name: str.optional(),
      state: str.optional(),
      completed: z.boolean().optional(),
      detail: str.optional(),
      shortDetail: str.optional(),
    })
    .optional(),
});

const competitorSchema = z.looseObject({
  homeAway: str.optional(),
  score: numLike.optional(),
  team: teamSchema.optional(),
});

const competitionSchema = z.looseObject({
  date: str.optional(),
  status: statusSchema.optional(),
  competitors: z.array(competitorSchema).optional(),
});

export const scoreboardResponseSchema = z.looseObject({
  events: z
    .array(
      z.looseObject({
        id: idLike.optional(),
        date: str.optional(),
        season: z.looseObject({ year: numLike.optional(), type: numLike.optional() }).optional(),
        status: statusSchema.optional(),
        competitions: z.array(competitionSchema).optional(),
      }),
    )
    .optional(),
});

export const summaryResponseSchema = z.looseObject({
  boxscore: z
    .looseObject({
      players: z
        .array(
          z.looseObject({
            team: teamSchema.optional(),
            statistics: z
              .array(
                z.looseObject({
                  labels: z.array(str).optional(),
                  athletes: z
                    .array(
                      z.looseObject({
                        athlete: athleteSchema.optional(),
                        starter: z.boolean().optional(),
                        didNotPlay: z.boolean().optional(),
                        reason: str.optional(),
                        stats: z.array(str).optional(),
                      }),
                    )
                    .optional(),
                }),
              )
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  header: z
    .looseObject({
      id: idLike.optional(),
      season: z.looseObject({ year: numLike.optional(), type: numLike.optional() }).optional(),
      competitions: z.array(competitionSchema).optional(),
    })
    .optional(),
});

export const injuriesResponseSchema = z.looseObject({
  injuries: z
    .array(
      z.looseObject({
        id: idLike.optional(),
        displayName: str.optional(),
        injuries: z
          .array(
            z.looseObject({
              id: idLike.optional(),
              status: str.optional(),
              shortComment: str.optional(),
              longComment: str.optional(),
              date: str.optional(),
              athlete: z
                .looseObject({
                  id: idLike.optional(),
                  displayName: str.optional(),
                  links: z.array(z.looseObject({ href: str.optional() })).optional(),
                })
                .optional(),
              details: z
                .looseObject({ type: str.optional(), detail: str.optional(), returnDate: str.optional() })
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

export const newsResponseSchema = z.looseObject({
  articles: z
    .array(
      z.looseObject({
        id: idLike.optional(),
        headline: str.optional(),
        description: str.optional(),
        published: str.optional(),
        images: z.array(z.looseObject({ url: str.optional() })).optional(),
        categories: z
          .array(z.looseObject({ type: str.optional(), athleteId: idLike.optional(), teamId: idLike.optional() }))
          .optional(),
        links: z.looseObject({ web: z.looseObject({ href: str.optional() }).optional() }).optional(),
      }),
    )
    .optional(),
});

export type RawTeams = z.infer<typeof teamsResponseSchema>;
export type RawRoster = z.infer<typeof rosterResponseSchema>;
export type RawScoreboard = z.infer<typeof scoreboardResponseSchema>;
export type RawSummary = z.infer<typeof summaryResponseSchema>;
export type RawInjuries = z.infer<typeof injuriesResponseSchema>;
export type RawNews = z.infer<typeof newsResponseSchema>;

/**
 * Validates `data` against `schema`. On shape drift, warns and returns the data as-is (typed
 * optimistically) so one odd field never takes a whole sync down.
 */
export function parseLoose<S extends z.ZodType>(schema: S, data: unknown, label: string): z.infer<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  console.warn(`[espn] unexpected ${label} shape: ${issue?.message ?? "invalid"} at ${issue?.path.join(".")}`);
  return (data && typeof data === "object" ? data : {}) as z.infer<S>;
}
