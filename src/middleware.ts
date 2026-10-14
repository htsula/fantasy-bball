import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "@/lib/auth/constants";

const PUBLIC_PREFIXES = ["/login", "/invite/", "/reset/", "/api/cron/"];

/**
 * Optimistic gate: only checks that a session cookie exists. Real validation
 * happens in requireUser()/requireAdmin(), which hit the DB.
 * For signed-in requests it also re-issues the cookie to keep its 400-day expiry sliding
 * (the DB expiry is extended in validateSession).
 */
export function middleware(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const { pathname } = req.nextUrl;
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname.startsWith(p) || pathname === p.slice(0, -1));

  if (!token && !isPublic) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const res = NextResponse.next();
  if (token) {
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
  }
  return res;
}

export const config = {
  // Skip Next internals and any path with a file extension (static assets).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
