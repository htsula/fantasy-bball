import type { Instrumentation } from "next";

/**
 * Next.js calls this for every unhandled server error (render, route handler, server action). We log one
 * structured line with the route and the error digest, the same digest the error page shows to the user,
 * so "Reference: abc123" in a screenshot can be searched in Vercel Logs.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const { log } = await import("@/lib/log");
  const digest = (err as { digest?: string } | null)?.digest;
  log.error(
    "request.error",
    {
      digest,
      method: request.method,
      path: request.path.split("?")[0],
      routePath: context.routePath,
      routeType: context.routeType,
      renderSource: context.renderSource,
    },
    err,
  );
};
