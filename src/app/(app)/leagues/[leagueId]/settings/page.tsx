import { RulesSummary } from "@/components/leagues/rules-summary";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { SettingsForm } from "./settings-form";

export default async function SettingsPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const { view } = await loadLeagueView(leagueId);
  const { league, settings, teams, isCommissioner } = view;
  return (
    <div className="grid gap-6">
      {isCommissioner && (
        <SettingsForm
          leagueId={league.id}
          settings={settings}
          draftLocked={league.status !== "setup"}
          teamCount={teams.length}
        />
      )}
      <RulesSummary settings={settings} teamCount={teams.length} />
    </div>
  );
}
