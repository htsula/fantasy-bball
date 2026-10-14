"use client";

import { useParams } from "next/navigation";
import { ErrorView } from "@/components/error-view";

export default function LeagueError(props: { error: Error & { digest?: string }; reset: () => void }) {
  const { leagueId } = useParams<{ leagueId: string }>();
  return <ErrorView {...props} homeHref={leagueId ? `/leagues/${leagueId}` : "/leagues"} homeLabel="Back to the league" />;
}
