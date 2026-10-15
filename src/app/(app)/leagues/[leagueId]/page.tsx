import Link from "next/link";
import { db } from "@/db";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChatText } from "@/components/chat/chat-text";
import { listActivity, typeLabel } from "@/lib/activity/service";
import { latestAnnouncement, listMessages } from "@/lib/chat/service";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { getSchedule } from "@/lib/leagues/service";
import { periodLabel } from "@/lib/matchups/labels";
import { getDraftByLeague } from "@/lib/draft/service";
import { getFocusPeriod, getMatchupForTeam, getMatchupTotals, getStandings } from "@/lib/matchups/service";
import { listTransactions } from "@/lib/rosters/service";
import { fmtEtDateTime, fmtNum } from "@/lib/nba/format";
import { fmtYmd } from "@/lib/nba/format";
import { ensureFreshLive } from "@/lib/nba/sync";
import { getLeagueHistory } from "@/lib/seasons/service";

export default async function LeagueHomePage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const { user, view } = await loadLeagueView(leagueId);
  const { league, settings, teams, myTeam, isCommissioner } = view;
  const schedule = await getSchedule(db, league.id);
  const draft = await getDraftByLeague(db, league.id);
  const n = teams.length;
  const regular = schedule.periods.filter((p) => !p.isPlayoff);
  const playoff = schedule.periods.filter((p) => p.isPlayoff);
  const base = `/leagues/${league.id}`;
  const inSeason = league.status === "in_season" || league.status === "playoffs";
  const draftDone = draft?.status === "complete";

  let myMatchup: { id: string; label: string; me: { name: string; points: number; projected: number; left: number }; opp: { name: string; points: number; projected: number; left: number } | null; status: string } | null = null;
  let standingsRows: Awaited<ReturnType<typeof getStandings>> = [];
  let recent: Awaited<ReturnType<typeof listTransactions>>["rows"] = [];
  if (inSeason) {
    await ensureFreshLive(db);
    const period = await getFocusPeriod(db, league.id);
    const m = period && myTeam ? await getMatchupForTeam(db, period.id, myTeam.id) : null;
    if (period && m && myTeam) {
      const totals = await getMatchupTotals(db, m.id);
      const mineIsHome = m.homeTeamId === myTeam.id;
      const side = (t: typeof totals.home | null) =>
        t ? { name: teams.find((x) => x.id === t.teamId)?.name ?? "Unknown team", points: t.points, projected: t.projected, left: t.gamesRemaining } : null;
      const [a, b] = mineIsHome ? [totals.home, totals.away] : [totals.away, totals.home];
      myMatchup = {
        id: m.id,
        label: periodLabel(period, schedule.periods),
        me: side(a)!,
        opp: side(b),
        status: m.status,
      };
    }
    standingsRows = await getStandings(db, league.id);
    recent = (await listTransactions(db, league.id, { limit: 5 })).rows;
  }
  const [announcement, chatPreview, activityPreview] = await Promise.all([
    latestAnnouncement(db, league.id),
    listMessages(db, user, league.id, { limit: 5, includeDeleted: false }),
    listActivity(db, league.id, { limit: 5 }),
  ]);
  const memberNames = teams.map((t) => t.ownerUsername);
  const champion =
    league.status === "complete"
      ? ((await getLeagueHistory(db, league.id)).find((h) => h.leagueId === league.id)?.champion ?? null)
      : null;
  const standingsShown = standingsRows.filter((r) => r.rank <= 4 || r.teamId === myTeam?.id);

  return (
    <div className="grid gap-6">
      {settings.playoffTeams > n && (
        <p className="rounded-md bg-muted px-3 py-2 text-sm">
          Playoffs are set to {settings.playoffTeams} teams but the league has {n}. Lower it in settings or add teams
          before generating the schedule.
        </p>
      )}

      {announcement && (
        <Card className="border-primary/40 bg-primary/5" data-testid="latest-announcement">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              <Badge>Announcement</Badge>
              <span className="text-sm font-normal text-muted-foreground">
                {announcement.username}, {fmtEtDateTime(announcement.createdAt)}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <ChatText body={announcement.body} members={memberNames} />
          </CardContent>
        </Card>
      )}

      {(league.status === "playoffs" || league.status === "complete") && (
        <Card data-testid="playoffs-card">
          <CardHeader>
            <CardTitle>{league.status === "complete" ? "Season complete" : "Playoffs"}</CardTitle>
            <CardDescription>
              {league.status === "complete"
                ? champion
                  ? `${champion.teamName} are the champions.`
                  : "The season is over."
                : "The playoffs are underway. Follow the bracket."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Link href={`${base}/playoffs`} className={buttonVariants({ size: "sm" })}>
              View bracket
            </Link>
            <Link href={`${base}/history`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              {league.status === "complete" && isCommissioner ? "History and next season" : "League history"}
            </Link>
          </CardContent>
        </Card>
      )}

      {!draftDone && (
      <Card data-testid="draft-card">
        <CardHeader>
          <CardTitle>Draft</CardTitle>
          <CardDescription>
            {!draft && "Not started. Each team can build a queue before the commissioner starts the draft."}
            {draft?.status === "snake" && "The snake draft is underway."}
            {draft?.status === "waves" && "The wave phase is underway: everyone picks at once."}
            {draft?.status === "complete" && "The draft is complete."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href={`${base}/draft`} className={buttonVariants({ variant: draft?.status === "complete" ? "outline" : "default", size: "sm" }) + " w-fit"}>
            {!draft ? (isCommissioner ? "Set up the draft" : "Build your queue") : draft.status === "complete" ? "View draft recap" : "Go to the draft room"}
          </Link>
        </CardContent>
      </Card>
      )}

      {inSeason && myMatchup && (
        <Card data-testid="my-matchup-card">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              Your matchup <Badge variant="outline">{myMatchup.label}</Badge>
              <Badge variant={myMatchup.status === "final" ? "secondary" : "outline"}>
                {{ scheduled: "Upcoming", live: "In progress", final: "Final" }[myMatchup.status as "scheduled" | "live" | "final"]}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              {[myMatchup.me, myMatchup.opp].map((t, i) =>
                t ? (
                  <div key={i} className="grid gap-0.5">
                    <span className="truncate text-sm font-medium">{t.name}</span>
                    <span className="text-2xl font-bold tabular-nums" data-testid={i === 0 ? "my-points" : "opp-points"}>
                      {fmtNum(t.points, 1)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Proj {fmtNum(t.projected, 1)} &middot; {t.left} games left
                    </span>
                  </div>
                ) : (
                  <div key={i} className="text-sm text-muted-foreground">Bye week</div>
                ),
              )}
            </div>
            <Link href={`${base}/matchup/${myMatchup.id}`} className={buttonVariants({ size: "sm" }) + " w-fit"}>
              Open box score
            </Link>
          </CardContent>
        </Card>
      )}

      {inSeason && (
        <Card data-testid="standings-snapshot">
          <CardHeader>
            <CardTitle>Standings</CardTitle>
            <CardDescription>Top 4 and your team.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">#</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead className="text-right">W-L-T</TableHead>
                  <TableHead className="text-right">PF</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {standingsShown.map((r) => (
                  <TableRow key={r.teamId} data-testid="snapshot-row">
                    <TableCell>{r.rank}</TableCell>
                    <TableCell className="font-medium">
                      {r.name} {r.teamId === myTeam?.id && <Badge variant="outline">You</Badge>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.wins}-{r.losses}-{r.ties}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(r.pointsFor, 1)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Link href={`${base}/standings`} className={buttonVariants({ variant: "outline", size: "sm" }) + " w-fit"}>
              Full standings
            </Link>
          </CardContent>
        </Card>
      )}

      {inSeason && (
        <Card data-testid="recent-transactions">
          <CardHeader>
            <CardTitle>Recent transactions</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {recent.length === 0 ? (
              <p className="text-muted-foreground">No transactions yet.</p>
            ) : (
              recent.map((r) => (
                <div key={r.id} className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    <span className="font-medium">{r.teamName}</span> {r.type.replace(/_/g, " ")} {r.playerName}
                  </span>
                  <span className="text-xs text-muted-foreground">{fmtEtDateTime(r.createdAt)}</span>
                </div>
              ))
            )}
            <Link href={`${base}/transactions`} className={buttonVariants({ variant: "outline", size: "sm" }) + " w-fit"}>
              All transactions
            </Link>
          </CardContent>
        </Card>
      )}

      <Card data-testid="chat-preview">
        <CardHeader>
          <CardTitle>League chat</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {chatPreview.messages.length === 0 ? (
            <p className="text-muted-foreground">No messages yet.</p>
          ) : (
            chatPreview.messages.map((m) => (
              <div key={m.id} data-testid="chat-preview-message" className="grid gap-0.5">
                <span>
                  <span className="font-medium">{m.username}</span>{" "}
                  <span className="text-xs text-muted-foreground">{fmtEtDateTime(new Date(m.createdAt))}</span>
                </span>
                <span className="line-clamp-2">
                  <ChatText body={m.body ?? ""} members={memberNames} />
                </span>
              </div>
            ))
          )}
          <Link href={`${base}/chat`} className={buttonVariants({ variant: "outline", size: "sm" }) + " w-fit"}>
            Open chat
          </Link>
        </CardContent>
      </Card>

      <Card data-testid="activity-preview">
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {activityPreview.entries.length === 0 ? (
            <p className="text-muted-foreground">Nothing yet.</p>
          ) : (
            activityPreview.entries.map((e) => (
              <div key={e.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  <Badge variant="outline">{typeLabel(e.type)}</Badge> {e.summary}
                  {e.actorUsername ? <span className="text-xs text-muted-foreground"> (by {e.actorUsername})</span> : null}
                </span>
                <span className="text-xs text-muted-foreground">{fmtEtDateTime(e.createdAt)}</span>
              </div>
            ))
          )}
          <Link href={`${base}/activity`} className={buttonVariants({ variant: "outline", size: "sm" }) + " w-fit"}>
            Full activity log
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Teams</CardTitle>
          <CardDescription>
            {myTeam ? `You manage ${myTeam.name}.` : "You are viewing this league as a site admin."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Team</TableHead>
                <TableHead>Abbrev</TableHead>
                <TableHead>Owner</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teams.map((t) => (
                <TableRow key={t.id} data-testid="team-row">
                  <TableCell className="font-medium">
                    <Link href={`${base}/teams/${t.id}`} className="underline-offset-4 hover:underline">
                      {t.name}
                    </Link>{" "}
                    {t.id === myTeam?.id && <Badge variant="outline">You</Badge>}
                  </TableCell>
                  <TableCell>{t.abbrev}</TableCell>
                  <TableCell>
                    {t.ownerUsername}
                    {t.ownerId === league.commissionerId && (
                      <span className="text-muted-foreground"> (commissioner)</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Schedule</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {schedule.periods.length === 0 ? (
            <p className="text-muted-foreground">
              No schedule yet.{isCommissioner ? " Generate it from the schedule page once your teams have joined." : ""}
            </p>
          ) : (
            <p>
              {regular.length} regular-season weeks ({fmtYmd(regular[0].startDate)} to{" "}
              {fmtYmd(regular[regular.length - 1].endDate)}) followed by {playoff.length} playoff{" "}
              {playoff.length === 1 ? "week" : "weeks"} ending {fmtYmd(schedule.periods[schedule.periods.length - 1].endDate, true)}.
            </p>
          )}
          <Link href={`${base}/schedule`} className={buttonVariants({ variant: "outline", size: "sm" }) + " w-fit"}>
            {schedule.periods.length === 0 && isCommissioner ? "Set up schedule" : "View schedule"}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
