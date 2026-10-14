import Link from "next/link";
import { db } from "@/db";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/session";
import { LEAGUE_STATUS_LABEL } from "@/lib/leagues/labels";
import { listLeagues, type LeagueSummary } from "@/lib/leagues/service";
import { seasonLabel } from "@/lib/nba/format";

export const dynamic = "force-dynamic";

function LeagueList({ items, empty }: { items: LeagueSummary[]; empty?: string }) {
  if (items.length === 0) return empty ? <p className="text-sm text-muted-foreground">{empty}</p> : null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {items.map(({ league, teamCount, myTeamName }) => (
        <Link key={league.id} href={`/leagues/${league.id}`} className="block">
          <Card className="transition-colors hover:bg-muted/50">
            <CardHeader>
              <CardTitle>{league.name}</CardTitle>
              <CardDescription>
                {seasonLabel(league.season)} &middot; {teamCount} {teamCount === 1 ? "team" : "teams"}
                {myTeamName ? ` · ${myTeamName}` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Badge variant="secondary">{LEAGUE_STATUS_LABEL[league.status]}</Badge>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}

export default async function LeaguesPage() {
  const user = await requireUser();
  const { mine, others } = await listLeagues(db, user);
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Leagues</h1>
        {user.isSiteAdmin && (
          <Link href="/leagues/new" className={buttonVariants({ size: "sm" })}>
            Create league
          </Link>
        )}
      </div>
      <section className="grid gap-3">
        <h2 className="text-lg font-semibold">My leagues</h2>
        <LeagueList
          items={mine}
          empty={
            user.isSiteAdmin
              ? "You're not in any leagues yet. Create one to get started."
              : "You're not in any leagues yet. Ask your commissioner for an invite link."
          }
        />
      </section>
      {others.length > 0 && (
        <section className="grid gap-3">
          <h2 className="text-lg font-semibold">All other leagues (admin)</h2>
          <LeagueList items={others} />
        </section>
      )}
    </div>
  );
}
