import { NbaScoreboard } from "@/components/nba/nba-scoreboard";
import { requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export default async function ScoreboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  return <NbaScoreboard searchParams={searchParams} basePath="/nba/scoreboard" />;
}
