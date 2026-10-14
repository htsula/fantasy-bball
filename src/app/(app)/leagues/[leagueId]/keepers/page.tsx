import { db } from "@/db";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { fmtYmd } from "@/lib/nba/format";
import { getKeeperView } from "@/lib/seasons/service";
import { KeepersForm } from "./keepers-form";

export const dynamic = "force-dynamic";

export default async function KeepersPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const { user, view } = await loadLeagueView(leagueId);
  const keepers = await getKeeperView(db, user, view.league.id);

  if (!keepers.enabled) {
    return (
      <div className="grid gap-2">
        <h2 className="text-xl font-semibold">Keepers</h2>
        <p className="text-sm text-muted-foreground">This league has no keepers.</p>
      </div>
    );
  }
  const locked = !keepers.open || (keepers.deadlinePassed && !keepers.isCommissioner);

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-xl font-semibold">Keepers</h2>
        <p className="text-sm text-muted-foreground">
          Each team keeps up to {keepers.limit} player{keepers.limit === 1 ? "" : "s"} from last season&apos;s final roster who are
          still active on an NBA roster. Keepers go on your roster when the draft starts and count toward your roster size,
          so you draft that many fewer players (in the wave phase).
          {keepers.deadline ? ` Deadline: ${fmtYmd(keepers.deadline, true)}${keepers.isCommissioner ? " (the commissioner can always edit)" : ""}.` : ""}
        </p>
        {!keepers.open && <p className="text-sm font-medium">Keepers are locked because the draft has started.</p>}
        {keepers.open && keepers.deadlinePassed && !keepers.isCommissioner && (
          <p className="text-sm font-medium">The keeper deadline has passed. Ask the commissioner to make changes.</p>
        )}
      </div>
      {keepers.teams.length === 0 && <p className="text-sm text-muted-foreground">You don&apos;t have a team in this league.</p>}
      {keepers.teams.map((t) => (
        <Card key={t.teamId} size="sm" data-testid="keepers-team">
          <CardHeader>
            <CardTitle>{t.teamName}</CardTitle>
            <CardDescription>Owner: {t.ownerUsername}</CardDescription>
          </CardHeader>
          <CardContent>
            <KeepersForm
              leagueId={view.league.id}
              teamId={t.teamId}
              teamName={t.teamName}
              candidates={t.candidates.map((p) => ({
                id: p.id,
                name: p.name,
                nbaTeam: p.nbaTeam,
                positions: p.positions,
                lastFp: p.lastFp,
                lastAvg: p.lastAvg,
              }))}
              selected={t.selected}
              limit={keepers.limit}
              locked={locked}
            />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
