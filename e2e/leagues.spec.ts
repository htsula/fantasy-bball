import { expect, test } from "@playwright/test";

test("admin creates a league, invites a new user with a team, generates the schedule", async ({ page, browser }) => {
  test.setTimeout(120_000); // first hits compile each league route in dev mode
  await page.goto("/login");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("e2e-admin-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Welcome, admin" })).toBeVisible();

  // Create a league with the admin's own team.
  await page.getByRole("link", { name: "Leagues", exact: true }).click();
  await page.getByRole("link", { name: "Create league" }).click();
  await page.getByLabel("League name").fill("E2E League");
  await page.getByLabel("Team name").fill("Commish Crew");
  await page.getByLabel("Abbreviation (2-4 letters)").fill("ccr");
  await page.getByRole("button", { name: "Create league" }).click();
  await expect(page.getByRole("heading", { name: "E2E League" })).toBeVisible();
  await expect(page.getByTestId("team-row")).toHaveCount(1);
  await expect(page.getByText("Max roster")).toBeVisible();

  // Create a league invite link.
  await page.getByRole("link", { name: "Invite" }).click();
  await page.getByRole("button", { name: "Create league invite link" }).click();
  const link = page.getByLabel("Generated link");
  await expect(link).toHaveValue(/\/invite\//);
  const inviteUrl = await link.inputValue();

  // A new user signs up from the link, naming their team in the same form.
  const friend = await browser.newContext();
  const fp = await friend.newPage();
  await fp.goto(inviteUrl);
  await expect(fp.getByText("Your team in E2E League")).toBeVisible();
  await fp.getByLabel("Username").fill("leaguer");
  await fp.getByLabel("Password (min 8 characters)").fill("friend-password-1");
  await fp.getByLabel("Confirm password").fill("friend-password-1");
  await fp.getByLabel("Team name").fill("commish crew"); // case-insensitive duplicate
  await fp.getByLabel("Team abbreviation (2-4 letters)").fill("RKS");
  await fp.getByRole("button", { name: "Create account" }).click();
  await expect(fp.getByText("Another team in this league already uses that name.")).toBeVisible();
  await fp.getByLabel("Team name").fill("Rookies");
  await fp.getByLabel("Password (min 8 characters)").fill("friend-password-1");
  await fp.getByLabel("Confirm password").fill("friend-password-1");
  await fp.getByRole("button", { name: "Create account" }).click();
  await expect(fp.getByRole("heading", { name: "E2E League" })).toBeVisible();
  await expect(fp.getByTestId("team-row")).toHaveCount(2);
  await expect(fp.getByRole("link", { name: "Invite" })).toHaveCount(0); // not the commissioner
  await expect(fp.getByRole("link", { name: "Rules" })).toBeVisible();

  // Both teams are visible to the commissioner; the owner usernames are shown.
  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByTestId("team-row")).toHaveCount(2);
  await expect(page.getByRole("row", { name: /Rookies.*leaguer/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Commish Crew.*admin/ })).toBeVisible();

  // The NBA schedule for this season isn't loaded, so the commissioner enters dates (and 2 playoff teams).
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Regular season start").fill("2026-10-20");
  await page.getByLabel("Regular season end").fill("2026-12-20");
  await page.getByLabel("Playoff teams").selectOption("2");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  const rules = page.getByTestId("league-rules");
  await expect(rules).toContainText("Team win bonus");
  await expect(rules).toContainText("+4");
  await expect(rules).toContainText("50 players");

  // Members see the rules read-only.
  await fp.getByRole("link", { name: "Rules" }).click();
  await expect(fp.getByTestId("league-rules")).toContainText("Team win bonus");
  await expect(fp.getByRole("button", { name: "Save settings" })).toHaveCount(0);

  // Generate the schedule.
  await page.getByRole("link", { name: "Schedule" }).click();
  await page.getByRole("button", { name: "Generate schedule" }).click();
  await expect(page.getByText("Schedule generated")).toBeVisible();
  await expect(page.getByText("Week 1").first()).toBeVisible();
  await expect(page.getByText("Playoffs - round 1")).toBeVisible();
  await expect(page.getByTestId("matchup").first()).toContainText(/Commish Crew vs Rookies|Rookies vs Commish Crew/);
  expect(await page.getByTestId("matchup").count()).toBe(8);
  await expect(page.locator('[data-testid="matchup"][data-mine="true"]')).toHaveCount(8);

  // The member sees the same schedule with their team highlighted.
  await fp.getByRole("link", { name: "Schedule" }).click();
  await expect(fp.locator('[data-testid="matchup"][data-mine="true"]')).toHaveCount(8);
  await expect(fp.getByRole("button", { name: "Generate schedule" })).toHaveCount(0);

  // An already-signed-in user opening another league's invite joins with a new team (no new account).
  await page.goto("/leagues/new");
  await page.getByLabel("League name").fill("Second League");
  await page.getByLabel("Team name").fill("Other Team");
  await page.getByLabel("Abbreviation (2-4 letters)").fill("OTH");
  await page.getByRole("button", { name: "Create league" }).click();
  await expect(page.getByRole("heading", { name: "Second League" })).toBeVisible();
  await page.getByRole("link", { name: "Invite" }).click();
  await page.getByRole("button", { name: "Create league invite link" }).click();
  const secondUrl = await page.getByLabel("Generated link").inputValue();
  await fp.goto(secondUrl);
  await expect(fp.getByText("Join Second League as a new team")).toBeVisible();
  await fp.getByLabel("Team name").fill("Rookies Two");
  await fp.getByLabel("Team abbreviation (2-4 letters)").fill("RKB");
  await fp.getByRole("button", { name: "Join league" }).click();
  await expect(fp.getByRole("heading", { name: "Second League" })).toBeVisible();
  await fp.goto("/");
  await expect(fp.getByRole("link", { name: "E2E League" })).toBeVisible();
  await expect(fp.getByRole("link", { name: "Second League" })).toBeVisible();

  await friend.close();
});
