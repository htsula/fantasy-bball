import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { nbaPlayers, nbaTeams, rosterEntries } from "@/db/schema";
import {
  AnnouncementForm,
  OpenTrades,
  RestartDraft,
  RosterTools,
  ScoreAdjust,
  TeamAdmin,
  TransferCommissioner,
  type PeriodOption,
} from "@/components/commissioner/commissioner-tools";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getDraftByLeague } from "@/lib/draft/service";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { getSchedule } from "@/lib/leagues/service";
import { periodLabel } from "@/lib/matchups/labels";
import { getFocusPeriod, listLeagueAdjustments } from "@/lib/matchups/service";
import { fmtEtDateTime, fmtNum } from "@/lib/nba/format";
import { listTransactions } from "@/lib/rosters/service";
import { TRADE_STATUS_LABEL } from "@/lib/trades/labels";
import { listLeagueTrades } from "@/lib/trades/service";

export const dynamic = "force-dynamic";

function Section({ title, description, children, testId }: { title: string; description?: string; children: React.ReactNode; testId?: string }) {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="grid gap-3">{children}</CardContent>
    </Card>
  );
}

export default async function CommissionerPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const { view } = await loadLeagueView(leagueId);
  if (!view.isCommissioner) notFound();
  const { league, teams } = view;
  const base = `/leagues/${leagueId}`;
  const open = league.status === "in_season" || league.status === "playoffs";

  const [draft, schedule, focus, adjustments, openTrades, cuts, rosterRows] = await Promise.all([
    getDraftByLeague(db, leagueId),
    getSchedule(db, leagueId),
    getFocusPeriod(db, leagueId),
    listLeagueAdjustments(db, leagueId, 15),
    listLeagueTrades(db, leagueId, { statuses: ["proposed", "pending_review"] }),
    listTransactions(db, leagueId, { type: "auto_drop", limit: 50 }),
    db
      .select({
        teamId: rosterEntries.teamId,
        id: nbaPlayers.id,
        name: nbaPlayers.fullName,
        positions: nbaPlayers.positions,
        nba: nbaTeams.abbrev,
      })
      .from(rosterEntries)
      .innerJoin(nbaPlayers, eq(nbaPlayers.id, rosterEntries.playerId))
      .leftJoin(nbaTeams, eq(nbaTeams.id, nbaPlayers.teamId))
      .where(and(eq(rosterEntries.leagueId, leagueId), isNull(rosterEntries.releasedAt)))
      .orderBy(asc(nbaPlayers.fullName)),
  ]);

  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const periods: PeriodOption[] = schedule.periods
    .filter((p) => p.matchups.length > 0)
    .map((p) => ({
      id: p.id,
      label: periodLabel(p, schedule.periods),
      matchups: p.matchups
        .filter((m) => m.homeTeamId)
        .map((m) => ({
          id: m.id,
          label: m.awayTeamId ? `${teamName.get(m.homeTeamId!)} vs ${teamName.get(m.awayTeamId)}` : `${teamName.get(m.homeTeamId!)} (bye)`,
          status: m.status,
          teams: [m.homeTeamId!, m.awayTeamId]
            .filter((x): x is string => x !== null)
            .map((id) => ({ id, name: teamName.get(id) ?? "Unknown team" })),
        })),
    }));

  const rosters = teams.map((t) => ({
    id: t.id,
    name: t.name,
    players: rosterRows
      .filter((r) => r.teamId === t.id)
      .map((r) => ({ id: r.id, name: r.name, detail: `${r.nba ?? "FA"} ${r.positions.join("/")}`.trim() })),
  }));
  const restorable = cuts.rows
    .filter((r) => r.restorable)
    .map((r) => ({ transactionId: r.id, teamName: r.teamName, playerName: r.playerName }));
  const candidates = teams
    .filter((t) => t.ownerId !== league.commissionerId)
    .map((t) => ({ teamId: t.id, label: `${t.ownerUsername} (${t.name})` }));
  const canRestartDraft = league.status === "drafting" && draft !== null && draft.status !== "complete";

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h2 className="text-xl font-semibold">Commissioner tools</h2>
        <p className="text-sm text-muted-foreground">
          Every action here is written to the{" "}
          <Link href={`${base}/activity`} className="underline underline-offset-4">
            activity log
          </Link>{" "}
          with your name, so the league can see what changed.
        </p>
      </div>

      <Section title="Announcement" description="Shown on the league overview and sent to every member." testId="section-announcement">
        <AnnouncementForm leagueId={leagueId} />
      </Section>

      <Section title="Members and teams" description="Rename a team, change its abbreviation, or give it to another existing user." testId="section-teams">
        <TeamAdmin
          leagueId={leagueId}
          canRemove={league.status === "setup"}
          teams={teams.map((t) => ({
            id: t.id,
            name: t.name,
            abbrev: t.abbrev,
            ownerUsername: t.ownerUsername,
            isCommissionerTeam: t.ownerId === league.commissionerId,
          }))}
        />
        <div className="flex flex-wrap gap-2">
          <Link href={`${base}/invite`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Invite link
          </Link>
          <Link href={`${base}/settings`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            League settings
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">
          Teams can only be removed during setup. Transferring ownership works any time; the new owner must not already own a team in
          this league. Your own team can&apos;t be given away: transfer the commissioner role first.
        </p>
      </Section>

      <Section title="Commissioner role" description="Hand the role to another team owner. You lose these tools immediately." testId="section-role">
        <TransferCommissioner leagueId={leagueId} candidates={candidates} />
      </Section>

      <Section title="Rosters" description="Add or drop for any team, and restore players the NBA cut." testId="section-rosters">
        <RosterTools leagueId={leagueId} teams={rosters} open={open} restorable={restorable} />
      </Section>

      <Section title="Score adjustments" description="Correct a matchup score by hand. Always needs a reason." testId="section-scores">
        <ScoreAdjust leagueId={leagueId} periods={periods} defaultPeriodId={focus?.id ?? null} />
        {adjustments.length > 0 && (
          <div className="grid gap-1 text-sm" data-testid="recent-adjustments">
            <h4 className="text-sm font-semibold">Recent adjustments</h4>
            {adjustments.map((a) => (
              <div key={a.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border px-2 py-1">
                <span>
                  <Link href={`${base}/matchup/${a.matchupId}`} className="underline underline-offset-4">
                    {a.isPlayoff ? "Playoff week" : "Week"} {a.periodNumber}
                  </Link>
                  : {a.teamName} {a.points > 0 ? "+" : ""}
                  {fmtNum(a.points, 1)} ({a.reason})
                </span>
                <span className="text-xs text-muted-foreground">
                  {a.actorUsername ?? "unknown"}, {fmtEtDateTime(a.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Draft" description="Pick for a team or undo a pick from the draft room." testId="section-draft">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{draft ? `Draft ${draft.status}` : "Not started"}</Badge>
          <Link href={`${base}/draft`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Go to the draft room
          </Link>
        </div>
        {canRestartDraft ? (
          <RestartDraft leagueId={leagueId} leagueName={league.name} />
        ) : (
          <p className="text-xs text-muted-foreground">
            The draft can only be restarted while it is in progress (not before it starts or once complete).
          </p>
        )}
      </Section>

      <Section title="Trades and playoffs" description="Open trades can be cancelled here. Reviews, vetoes and reversals are on each trade." testId="section-trades">
        <OpenTrades
          leagueId={leagueId}
          trades={openTrades.map((t) => ({
            id: t.id,
            summary: `${t.proposer.name} to ${t.receiver.name}: ${t.give.map((p) => p.name).join(", ") || "nothing"} for ${t.get.map((p) => p.name).join(", ") || "nothing"}`,
            status: TRADE_STATUS_LABEL[t.status],
          }))}
        />
        <div className="flex flex-wrap gap-2">
          <Link href={`${base}/trades`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            All trades
          </Link>
          <Link href={`${base}/playoffs`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Playoffs (re-seed, override a winner)
          </Link>
        </div>
      </Section>
    </div>
  );
}
