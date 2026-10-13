import { expect, test } from "@playwright/test";

test("admin invites a friend who redeems the link and lands on home", async ({ page, browser }) => {
  // Admin logs in and generates an invite link.
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/); // middleware redirect
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("e2e-admin-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Welcome, admin" })).toBeVisible();

  await page.goto("/admin");
  await page.getByRole("button", { name: "Generate invite link" }).click();
  const link = page.getByLabel("Generated link");
  await expect(link).toHaveValue(/\/invite\//);
  const inviteUrl = await link.inputValue();

  // A fresh browser context (no cookies) redeems it.
  const friend = await browser.newContext();
  const fp = await friend.newPage();
  await fp.goto(inviteUrl);
  await fp.getByLabel("Username").fill("newbie");
  await fp.getByLabel("Display name").fill("Newbie Nate");
  await fp.getByLabel("Password (min 8 characters)").fill("friend-password-1");
  await fp.getByLabel("Confirm password").fill("friend-password-1");
  await fp.getByRole("button", { name: "Create account" }).click();
  await expect(fp.getByRole("heading", { name: "Welcome, Newbie Nate" })).toBeVisible();
  await expect(fp.getByRole("link", { name: "Admin" })).toHaveCount(0);

  // The invite is single-use.
  await fp.context().clearCookies();
  await fp.goto(inviteUrl);
  await expect(fp.getByText("already been used")).toBeVisible();
  await friend.close();
});
