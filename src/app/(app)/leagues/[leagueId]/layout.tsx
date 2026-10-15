import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ChatNavBadge } from "@/components/chat/chat-nav-badge";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { ThemePicker } from "@/components/nav/theme-picker";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { ScrollNav, type NavItem } from "@/components/nav/scroll-nav";
import { chatUnreadCount } from "@/lib/chat/service";
import { LEAGUE_STATUS_LABEL } from "@/lib/leagues/labels";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { unreadCount } from "@/lib/notifications/service";
import { seasonLabel } from "@/lib/nba/format";
import { countReceivedOffers } from "@/lib/trades/service";
import { db } from "@/db";

export const dynamic = "force-dynamic";

export default async function LeagueLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;
  const { user, view } = await loadLeagueView(leagueId);
  const { league } = view;
  const base = `/leagues/${league.id}`;
  const offers = view.myTeam ? await countReceivedOffers(db, league.id, view.myTeam.id) : 0;
  const unreadChat = view.myTeam ? await chatUnreadCount(db, user.id, league.id) : 0;
  const unread = await unreadCount(db, user.id);
  const items: NavItem[] = [
    { href: base, label: "Overview", exact: true },
    ...(view.myTeam ? [{ href: `${base}/teams/${view.myTeam.id}`, label: "My team" }] : []),
    { href: `${base}/players`, label: "Players" },
    {
      href: `${base}/trades`,
      label: "Trades",
      testId: "nav-trades",
      badge:
        offers > 0 ? (
          <Badge className="ml-1" data-testid="nav-trades-badge" aria-label={`${offers} trade offer${offers === 1 ? "" : "s"} waiting`}>
            {offers}
          </Badge>
        ) : null,
    },
    { href: `${base}/transactions`, label: "Transactions" },
    { href: `${base}/activity`, label: "Activity", testId: "nav-activity" },
    { href: `${base}/chat`, label: "Chat", testId: "nav-chat", badge: <ChatNavBadge leagueId={league.id} initialCount={unreadChat} /> },
    { href: `${base}/draft`, label: "Draft" },
    { href: `${base}/matchup`, label: "Matchup" },
    { href: `${base}/scoreboard`, label: "Scoreboard" },
    { href: `${base}/nba-scoreboard`, label: "NBA Scoreboard" },
    { href: `${base}/standings`, label: "Standings" },
    { href: `${base}/schedule`, label: "Schedule" },
    { href: `${base}/playoffs`, label: "Playoffs", testId: "nav-playoffs" },
    ...(league.status === "setup" && view.settings.keepers > 0 && league.previousLeagueId
      ? [{ href: `${base}/keepers`, label: "Keepers", testId: "nav-keepers" }]
      : []),
    { href: `${base}/history`, label: "History", testId: "nav-history" },
    { href: `${base}/settings`, label: view.isCommissioner ? "Settings" : "Rules" },
    ...(view.isCommissioner
      ? [
          { href: `${base}/invite`, label: "Invite" },
          { href: `${base}/commissioner`, label: "Commissioner", testId: "nav-commissioner" },
        ]
      : []),
  ];
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/leagues"
            aria-label="Back to leagues"
            className={buttonVariants({ variant: "ghost", size: "icon" }) + " -ml-2"}
          >
            <ArrowLeft />
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">{league.name}</h1>
          <Badge variant="secondary">{LEAGUE_STATUS_LABEL[league.status]}</Badge>
          <div className="ml-auto flex items-center gap-1">
            <NotificationBell initialCount={unread} />
            <ThemePicker />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {seasonLabel(league.season)} season &middot; Commissioner: {view.commissionerUsername}
        </p>
        <ScrollNav label="League" items={items} />
      </div>
      {children}
    </div>
  );
}
