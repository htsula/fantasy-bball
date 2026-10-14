import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { LEAGUE_STATUS_LABEL } from "@/lib/leagues/labels";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { seasonLabel } from "@/lib/nba/format";

export const dynamic = "force-dynamic";

export default async function LeagueLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;
  const { view } = await loadLeagueView(leagueId);
  const { league } = view;
  const base = `/leagues/${league.id}`;
  const tab = buttonVariants({ variant: "ghost", size: "sm" });
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">{league.name}</h1>
          <Badge variant="secondary">{LEAGUE_STATUS_LABEL[league.status]}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {seasonLabel(league.season)} season &middot; Commissioner: {view.commissionerUsername}
        </p>
        <nav className="-mx-2 flex flex-wrap gap-1" aria-label="League">
          <Link href={base} className={tab}>
            Overview
          </Link>
          <Link href={`${base}/draft`} className={tab}>
            Draft
          </Link>
          <Link href={`${base}/schedule`} className={tab}>
            Schedule
          </Link>
          <Link href={`${base}/settings`} className={tab}>
            {view.isCommissioner ? "Settings" : "Rules"}
          </Link>
          {view.isCommissioner && (
            <Link href={`${base}/invite`} className={tab}>
              Invite
            </Link>
          )}
        </nav>
      </div>
      {children}
    </div>
  );
}
