import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { InjuryBadge } from "@/components/nba/injury-badge";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireUser } from "@/lib/auth/session";
import { fmtEtDate, fmtEtDateTime, fmtEtTime, fmtHeight, fmtNum, fmtPct, seasonLabel } from "@/lib/nba/format";
import { getPlayerCard } from "@/lib/nba/players-query";

export const dynamic = "force-dynamic";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-2 text-center">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export default async function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const playerId = Number(id);
  if (!Number.isInteger(playerId) || playerId <= 0) notFound();
  const card = await getPlayerCard(db, playerId);
  if (!card) notFound();
  const { player, team, injury, averages, gameLog, schedule, news, projection, remaining } = card;

  const bio = [
    player.jersey ? `#${player.jersey}` : null,
    fmtHeight(player.heightInches),
    player.weightLbs ? `${player.weightLbs} lbs` : null,
    player.age ? `${player.age} yrs` : null,
    player.experienceYears !== null ? (player.experienceYears === 0 ? "Rookie" : `${player.experienceYears} yr exp`) : null,
  ].filter(Boolean);

  return (
    <div className="grid gap-4">
      <Link href="/players" className={buttonVariants({ variant: "ghost", size: "sm", className: "w-fit" })}>
        Back to players
      </Link>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-4">
          {player.headshotUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={player.headshotUrl} alt={player.fullName} width={96} height={70} className="h-[70px] w-24 rounded-md bg-muted object-cover object-top" />
          ) : null}
          <div className="grid gap-1">
            <h1 className="text-2xl font-bold tracking-tight">{player.fullName}</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>{team ? `${team.location} ${team.name}` : "Free agent"}</span>
              <span>{player.positions.join("/") || player.espnPosition || ""}</span>
              {bio.length > 0 && <span>{bio.join(" - ")}</span>}
              <InjuryBadge status={player.injuryStatus} detail={player.injuryDetail} />
              {!player.active && <Badge variant="outline">inactive</Badge>}
            </div>
          </div>
        </CardContent>
      </Card>

      {injury && (
        <Card>
          <CardHeader>
            <CardTitle>
              Injury: {injury.status}
              {injury.detail ? ` (${injury.detail})` : ""}
            </CardTitle>
            {injury.date && <CardDescription>Updated {fmtEtDateTime(injury.date)} ET</CardDescription>}
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {injury.shortComment && <p>{injury.shortComment}</p>}
            {injury.longComment && <p className="text-muted-foreground">{injury.longComment}</p>}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{card.season ? `${seasonLabel(card.season)} averages` : "Averages"}</CardTitle>
          <CardDescription>
            Fantasy points use the default scoring.
            {projection?.projection != null && ` Projection ${fmtNum(projection.projection)} per game`}
            {remaining.week > 0 && `, ${remaining.week} game${remaining.week === 1 ? "" : "s"} left this week`}
            {card.projectedTotals.week != null && remaining.week > 0 && ` (about ${fmtNum(card.projectedTotals.week, 0)} FP)`}
            {remaining.season > 0 && `, ${remaining.season} left this season`}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {averages ? (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-12">
              <Stat label="GP" value={String(averages.gp)} />
              <Stat label="MIN" value={fmtNum(averages.min)} />
              <Stat label="PTS" value={fmtNum(averages.pts)} />
              <Stat label="REB" value={fmtNum(averages.reb)} />
              <Stat label="AST" value={fmtNum(averages.ast)} />
              <Stat label="STL" value={fmtNum(averages.stl)} />
              <Stat label="BLK" value={fmtNum(averages.blk)} />
              <Stat label="TO" value={fmtNum(averages.to)} />
              <Stat label="3PM" value={fmtNum(averages.tpm)} />
              <Stat label="FG%" value={fmtPct(averages.fgPct)} />
              <Stat label="FT%" value={fmtPct(averages.ftPct)} />
              <Stat label="FP/G" value={fmtNum(averages.fpAvg)} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No games played yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Game log</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Opp</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="text-right">MIN</TableHead>
                <TableHead className="text-right">PTS</TableHead>
                <TableHead className="text-right">REB</TableHead>
                <TableHead className="text-right">AST</TableHead>
                <TableHead className="text-right">STL</TableHead>
                <TableHead className="text-right">BLK</TableHead>
                <TableHead className="text-right">TO</TableHead>
                <TableHead className="text-right">FG</TableHead>
                <TableHead className="text-right">3P</TableHead>
                <TableHead className="text-right">FT</TableHead>
                <TableHead className="text-right">FP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {gameLog.length === 0 && (
                <TableRow>
                  <TableCell colSpan={14} className="text-muted-foreground">
                    No games yet.
                  </TableCell>
                </TableRow>
              )}
              {gameLog.map((g) => (
                <TableRow key={g.gameId}>
                  <TableCell>{fmtEtDate(g.date)}</TableCell>
                  <TableCell>
                    {g.home ? "vs" : "@"} {g.opponent}
                  </TableCell>
                  <TableCell>{g.result ?? "-"}</TableCell>
                  {g.stat.dnp ? (
                    <TableCell colSpan={10} className="text-muted-foreground">
                      DNP{g.stat.dnpReason ? ` - ${g.stat.dnpReason.toLowerCase()}` : ""}
                    </TableCell>
                  ) : (
                    <>
                      <TableCell className="text-right">{g.stat.minutes ?? "-"}</TableCell>
                      <TableCell className="text-right">{g.stat.pts}</TableCell>
                      <TableCell className="text-right">{g.stat.reb}</TableCell>
                      <TableCell className="text-right">{g.stat.ast}</TableCell>
                      <TableCell className="text-right">{g.stat.stl}</TableCell>
                      <TableCell className="text-right">{g.stat.blk}</TableCell>
                      <TableCell className="text-right">{g.stat.to}</TableCell>
                      <TableCell className="text-right">{g.stat.fgm}-{g.stat.fga}</TableCell>
                      <TableCell className="text-right">{g.stat.tpm}-{g.stat.tpa}</TableCell>
                      <TableCell className="text-right">{g.stat.ftm}-{g.stat.fta}</TableCell>
                    </>
                  )}
                  <TableCell className="text-right font-medium">{fmtNum(g.fantasyPoints, 0)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Upcoming schedule</CardTitle>
          </CardHeader>
          <CardContent>
            {schedule.length === 0 ? (
              <p className="text-sm text-muted-foreground">No upcoming games loaded.</p>
            ) : (
              <ul className="grid gap-1 text-sm">
                {schedule.map((g) => (
                  <li key={g.gameId} className="flex justify-between gap-2">
                    <span>
                      {fmtEtDate(g.date, { weekday: "short", month: "short", day: "numeric" })} {g.home ? "vs" : "@"} {g.opponent}
                    </span>
                    <span className="text-muted-foreground">{fmtEtTime(g.date)} ET</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>News</CardTitle>
          </CardHeader>
          <CardContent>
            {news.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent news.</p>
            ) : (
              <ul className="grid gap-3 text-sm">
                {news.map((n) => (
                  <li key={n.id} className="grid gap-0.5">
                    {n.link ? (
                      <a href={n.link} target="_blank" rel="noreferrer noopener" className="font-medium underline-offset-4 hover:underline">
                        {n.headline}
                      </a>
                    ) : (
                      <span className="font-medium">{n.headline}</span>
                    )}
                    {n.description && <span className="text-muted-foreground">{n.description}</span>}
                    <span className="text-xs text-muted-foreground">{fmtEtDateTime(n.published)} ET</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
