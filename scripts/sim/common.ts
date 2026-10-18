/** Paths and types shared by the simulation browser-pass tooling. */
import path from "node:path";

export const SIM_DIR = path.resolve(".pglite-sim");
export const SNAP_DIR = path.join(SIM_DIR, "_snapshots");
export const RESULT_DIR = path.join(SIM_DIR, "_results");
export const CHECKPOINTS = ["setup", "draft-snake", "draft-waves", "preseason", "regular-season", "playoffs", "complete", "next-season", "next-season-draft"] as const;
export type Checkpoint = (typeof CHECKPOINTS)[number];

export const dbDir = (cp: string) => path.join(SIM_DIR, cp);
export const snapFile = (cp: string) => path.join(SNAP_DIR, `${cp}.tar.gz`);
export const snapMeta = (cp: string) => path.join(SNAP_DIR, `${cp}.json`);
export const metaFile = (cp: string) => path.join(SIM_DIR, `${cp}.meta.json`);

export type SimUserMeta = { username: string; password: string; userId: string; teamId: string | null; teamName: string | null; role: "commissioner" | "member" | "non-member"; isSiteAdmin: boolean };
export type TeamMeta = { id: string; name: string; abbrev: string; ownerId: string; ownerUsername: string };
export type LeagueMeta = {
  id: string;
  name: string;
  season: number;
  status: string;
  teams: TeamMeta[];
  draft: { status: string; currentPick: number; currentWave: number | null; order: string[] } | null;
  /** Matchup ids for the chosen member's team. */
  matchups: { current?: string; past?: string; playoff?: string; otherPlayoff?: string; commishCurrent?: string };
  trades: Record<string, string>;
  playerIds: { rostered?: number; freeAgent?: number; retired?: number };
  invites: { active?: string; closed?: string; revoked?: string };
  periods: { number: number; isPlayoff: boolean; startDate: string; endDate: string }[];
  champion?: string;
  runnerUp?: string;
  /** Keeper player names per team id (rolled-over league). */
  keepers: Record<string, string[]>;
};
export type Meta = {
  checkpoint: Checkpoint;
  /** The checkpoint's instant. */
  now: string;
  users: SimUserMeta[];
  /** The member the crawl logs in as, and the commissioner. */
  member: SimUserMeta;
  commissioner: SimUserMeta;
  nonMember: SimUserMeta;
  league: LeagueMeta;
  next?: LeagueMeta;
  tokens: { siteValid: string; siteUsed: string; resetValid: string; resetUsed: string };
};
