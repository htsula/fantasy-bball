export const dynamic = "force-dynamic";

import { db } from "@/db";
import { InvalidLink } from "@/components/invalid-link";
import { getInviteStatus } from "@/lib/auth/service";
import { InviteForm } from "./invite-form";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const status = await getInviteStatus(db, token);
  if (status !== "valid") return <InvalidLink kind="invite" status={status} />;
  return <InviteForm token={token} />;
}
