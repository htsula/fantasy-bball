// Kept separate so the (edge) middleware can import it without pulling in node-only code.
export const SESSION_COOKIE = "fb_session";
// Sessions effectively never expire: 400 days is the longest cookie lifetime browsers allow
// (Chrome caps Max-Age there), and every visit slides it forward. Logging out or a password
// reset still ends a session.
export const SESSION_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
