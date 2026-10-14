import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const REASONS = {
  used: "This link has already been used.",
  expired: "This link has expired.",
  invalid: "This link isn't valid.",
  revoked: "This invite link was turned off by the commissioner.",
  full: "This invite link has reached its maximum number of teams.",
} as const;

export function InvalidLink({
  kind,
  status,
}: {
  kind: "invite" | "reset";
  status: keyof typeof REASONS | "valid";
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{kind === "invite" ? "Invite unavailable" : "Reset link unavailable"}</CardTitle>
        <CardDescription>
          {REASONS[status === "valid" ? "invalid" : status]}{" "}
          {status === "revoked" || status === "full" ? "Ask your commissioner for a new one." : "Ask the site admin for a new one."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link href="/login" className="text-sm underline underline-offset-4">
          Go to log in
        </Link>
      </CardContent>
    </Card>
  );
}
