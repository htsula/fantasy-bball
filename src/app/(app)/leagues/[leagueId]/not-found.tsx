import { NotFoundView } from "@/components/not-found-view";

export default function LeagueNotFound() {
  return (
    <NotFoundView
      title="League not found"
      message="This league or page doesn't exist, or you're not a member. Ask the commissioner for an invite link."
      href="/leagues"
      label="Your leagues"
    />
  );
}
