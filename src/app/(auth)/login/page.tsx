import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string }>;
}) {
  if (await getCurrentUser()) redirect("/");
  const { reset } = await searchParams;
  return <LoginForm passwordReset={reset === "1"} />;
}
