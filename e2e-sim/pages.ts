/** Every page the crawl visits, with what each kind of visitor should see at this checkpoint. */
import type { LeagueMeta, SimUserMeta } from "../scripts/sim/common";
import type { Expect } from "./lib";
import { meta } from "./lib";

export type PageSpec = { name: string; url: string; member: Expect; commissioner: Expect };

const NF: Expect = { notFound: true, noOverflow: true };
const snakeIdx = (n: number, teams: number) => {
  const round = Math.floor((n - 1) / teams);
  const pos = (n - 1) % teams;
  return round % 2 === 0 ? pos : teams - 1 - pos;
};

export function teamOf(l: LeagueMeta, user: SimUserMeta) {
  return l.teams.find((t) => t.ownerId === user.userId)!;
}

/** Text the draft room shows for the league's draft state. */
function draftText(l: LeagueMeta): (string | RegExp)[] {
  const d = l.draft;
  if (!d) return [/Draft/];
  if (d.status === "snake") {
    const team = l.teams.find((t) => t.id === d.order[snakeIdx(d.currentPick, d.order.length)])!;
    return ["Snake draft", "On the clock:", team.name, `pick #${d.currentPick}`];
  }
  if (d.status === "waves") return ["Wave draft", `Wave ${d.currentWave} of 10`, /waiting on/];
  return ["Draft complete"];
}

/** `plays`: the visitor's team has a matchup in the focus period (an eliminated team gets no "Your matchup" card). */
function overviewText(l: LeagueMeta, plays: boolean): (string | RegExp)[] {
  const base: (string | RegExp)[] = [l.name, "League chat"];
  const card = plays ? ["Your matchup"] : [];
  if (l.status === "setup") return [...base, "Not started"];
  if (l.status === "drafting") return [...base, l.draft?.status === "waves" ? "The wave phase is underway" : "The snake draft is underway"];
  if (l.status === "in_season") return [...base, ...card, "Standings"];
  if (l.status === "playoffs") return [...base, ...card, "The playoffs are underway"];
  return [...base, "Season complete", "are the champions"];
}

/** /matchup goes to the visitor's own matchup in the focus period, or to that period's scoreboard when it has none. */
function matchupRedirect(l: LeagueMeta, plays: boolean): Expect {
  if (plays) return { redirect: /\/matchup\/[0-9a-f-]{36}$/, text: [focusLabel(l)!] };
  return { redirect: /\/scoreboard\?period=\d+$/, text: [focusLabel(l)!] };
}

/** "Week N" / round name of the period the checkpoint's clock is in (else the next upcoming, else the last one). */
export function focusLabel(l: LeagueMeta): string | null {
  if (!l.periods.length) return null;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(meta.now));
  const p = l.periods.find((x) => x.startDate <= today && today <= x.endDate) ?? l.periods.find((x) => x.startDate > today) ?? l.periods[l.periods.length - 1];
  if (!p.isPlayoff) return `Week ${p.number}`;
  const first = l.periods.find((x) => x.isPlayoff)!.number;
  return ["Quarterfinal", "Semifinal", "Final"][p.number - first];
}

export function leaguePages(l: LeagueMeta, mine: string): PageSpec[] {
  const base = `/leagues/${l.id}`;
  const out: PageSpec[] = [];
  const both = (name: string, url: string, exp: Expect) => out.push({ name, url, member: exp, commissioner: exp });
  const started = l.status !== "setup";
  const scheduled = l.periods.length > 0;
  const other = l.teams.find((t) => t.id !== mine && !t.ownerUsername.startsWith("commish"))!;
  const commishTeam = l.teams.find((t) => t.ownerUsername === "commish")!;

  const memberPlays = Boolean(l.matchups.current);
  const commishPlays = Boolean(l.matchups.commishCurrent);
  out.push({
    name: "overview",
    url: base,
    member: { text: overviewText(l, memberPlays), shot: "overview" },
    commissioner: { text: overviewText(l, commishPlays), shot: "overview" },
  });
  both("activity", `${base}/activity`, { text: ["Activity"], shot: "activity" });
  both("activity-filtered", `${base}/activity?type=trade`, { text: ["Activity"] });
  both("chat", `${base}/chat`, { text: ["League chat"], shot: "chat" });
  out.push({ name: "commissioner", url: `${base}/commissioner`, member: NF, commissioner: { text: ["Commissioner tools"], shot: "commissioner" } });
  both("draft", `${base}/draft`, { text: draftText(l), shot: "draft" });
  both("history", `${base}/history`, { text: ["League history", ...(l.status === "complete" ? ["Champions"] : [])], shot: "history" });
  out.push({ name: "invite", url: `${base}/invite`, member: NF, commissioner: { text: ["Invite managers"], shot: "invite" } });
  both("keepers", `${base}/keepers`, { text: ["Keepers"], shot: "keepers" });
  if (scheduled) {
    out.push({ name: "matchup-redirect", url: `${base}/matchup`, member: matchupRedirect(l, memberPlays), commissioner: matchupRedirect(l, commishPlays) });
    if (l.matchups.current) both("matchup-current", `${base}/matchup/${l.matchups.current}`, { text: [memberTeamName(l)], shot: "matchup" });
    if (l.matchups.past) both("matchup-past", `${base}/matchup/${l.matchups.past}`, { text: [memberTeamName(l), "Final"], shot: "matchup-past" });
    if (l.matchups.playoff) both("matchup-playoff", `${base}/matchup/${l.matchups.playoff}`, { text: [/Playoff|Quarterfinal|Semifinal|Final/], shot: "matchup-playoff" });
    if (l.matchups.otherPlayoff && l.matchups.otherPlayoff !== l.matchups.playoff) both("matchup-playoff-2", `${base}/matchup/${l.matchups.otherPlayoff}`, { text: [/Playoff|Quarterfinal|Semifinal|Final/] });
    both("scoreboard", `${base}/scoreboard`, { text: [/Week|Playoff|Quarterfinal|Semifinal|Final/], shot: "scoreboard" });
    both("scoreboard-week-3", `${base}/scoreboard?period=3`, { text: ["Week 3"] });
    both("schedule", `${base}/schedule`, { text: [/Week 1\b/], shot: "schedule" });
  } else {
    both("matchup-redirect", `${base}/matchup`, { text: [/no schedule yet|schedule/i] });
    both("scoreboard", `${base}/scoreboard`, { text: [/schedule/i] });
    both("schedule", `${base}/schedule`, { text: [/schedule/i], shot: "schedule" });
  }
  both("nba-scoreboard", `${base}/nba-scoreboard`, { shot: "nba-scoreboard" });
  both("players", `${base}/players`, { text: ["Players"], shot: "players" });
  both("players-fa", `${base}/players?status=fa`, { text: ["Players"] });
  both("players-rostered", `${base}/players?status=rostered`, { text: ["Players"] });
  both("players-healthy", `${base}/players?healthy=1`, { text: ["Players"] });
  for (const r of ["7", "15", "30"]) both(`players-range-${r}`, `${base}/players?range=${r}`, { text: ["Players"] });
  both("players-search", `${base}/players?q=an&sort=fpavg`, { text: ["Players"] });
  both("players-page-2", `${base}/players?page=2&status=all`, { text: ["Players"] });
  both("playoffs", `${base}/playoffs`, {
    text: ["Playoffs", ...(l.status === "playoffs" || l.status === "complete" ? ["Quarterfinal", "Semifinal", "Final"] : [])],
    shot: "playoffs",
  });
  both("settings", `${base}/settings`, { shot: "settings" });
  both("standings", `${base}/standings`, { text: ["Standings"], shot: "standings" });
  both("team-mine", `${base}/teams/${mine}`, { text: [l.teams.find((t) => t.id === mine)!.name, "Roster"], shot: "team" });
  both("team-other", `${base}/teams/${other.id}`, { text: [other.name], shot: "team-other" });
  both("team-commish", `${base}/teams/${commishTeam.id}`, { text: [commishTeam.name] });
  both("trades", `${base}/trades`, { text: ["Trades"], shot: "trades" });
  for (const tab of ["incoming", "outgoing", "history"]) both(`trades-${tab}`, `${base}/trades?tab=${tab}`, { text: ["Trades"] });
  for (const [status, id] of Object.entries(l.trades)) both(`trade-${status}`, `${base}/trades/${id}`, { text: ["Timeline"], shot: `trade-${status}` });
  both("trade-block", `${base}/trades/block`, { text: ["Trade block"], shot: "trade-block" });
  both("trade-new", `${base}/trades/new`, { shot: "trade-new" });
  both("trade-new-with", `${base}/trades/new?with=${other.id}`, {});
  both("transactions", `${base}/transactions`, { text: ["Transactions"], shot: "transactions" });
  both("transactions-add", `${base}/transactions?type=add&page=2`, { text: ["Transactions"] });
  both("transactions-team", `${base}/transactions?team=${other.id}`, { text: ["Transactions"] });
  void started;
  return out;
}

/** Matchup ids in the metadata belong to the chosen member's team, whoever is looking. */
function memberTeamName(l: LeagueMeta) {
  return l.teams.find((t) => t.ownerId === meta.member.userId)!.name;
}

/** Site-wide pages (not tied to a league). */
export function sitePages(member: SimUserMeta, who: "member" | "commissioner" | "non-member") {
  const out: { name: string; url: string; exp: Expect }[] = [
    { name: "home", url: "/", exp: { text: [`Welcome, ${member.username}`], shot: "home" } },
    { name: "leagues", url: "/leagues", exp: { text: ["Leagues"], shot: "leagues" } },
    { name: "players", url: "/players", exp: { text: ["Players"], shot: "players-global" } },
    { name: "players-search", url: "/players?q=an&sort=fpavg&dir=desc", exp: { text: ["Players"] } },
    { name: "players-page-3", url: "/players?page=3", exp: { text: ["Players"] } },
    { name: "players-healthy", url: "/players?healthy=1&range=15", exp: { text: ["Players"] } },
    { name: "nba-scoreboard", url: "/nba/scoreboard", exp: { shot: "nba-scoreboard-global" } },
    { name: "nba-scoreboard-day", url: "/nba/scoreboard?date=2027-01-20", exp: {} },
    { name: "notifications", url: "/notifications", exp: { text: ["Notifications"], shot: "notifications" } },
    { name: "notification-settings", url: "/settings/notifications", exp: { text: ["Notifications"], shot: "notification-settings" } },
  ];
  if (who === "commissioner") {
    out.push({ name: "admin", url: "/admin", exp: { text: ["Admin"], shot: "admin" } });
    out.push({ name: "leagues-new", url: "/leagues/new", exp: { text: ["Create league"], shot: "leagues-new" } });
  } else {
    // Non-admins are sent home by requireAdmin.
    out.push({ name: "admin", url: "/admin", exp: { redirect: /^\/$/ } });
    out.push({ name: "leagues-new", url: "/leagues/new", exp: { redirect: /^\/$/ } });
  }
  return out;
}

export { meta };
