export const dynamic = "force-dynamic";

import { db } from "@/db";
import { InvalidLink } from "@/components/invalid-link";
import { getResetStatus } from "@/lib/auth/service";
import { ResetForm } from "./reset-form";

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const status = await getResetStatus(db, token);
  if (status !== "valid") return <InvalidLink kind="reset" status={status} />;
  return <ResetForm token={token} />;
}
