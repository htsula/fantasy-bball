import { NotFoundView } from "@/components/not-found-view";

export default function AppNotFound() {
  return (
    <NotFoundView
      title="Not found"
      message="This page doesn't exist, or you don't have access to it. If it's a league, ask the commissioner for an invite link."
      href="/leagues"
      label="Your leagues"
    />
  );
}
