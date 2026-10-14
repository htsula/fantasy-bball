/**
 * Chat text handling (pure). Bodies are stored RAW and never contain trusted markup: the renderer
 * turns them into a list of segments that the UI draws as React text nodes (React escapes them) and
 * plain <a> elements. Nothing here produces HTML, and only http(s) URLs become links.
 */

export const MAX_BODY_LENGTH = 2000;

export type ChatSegment =
  | { type: "text"; text: string }
  | { type: "link"; text: string; href: string }
  | { type: "mention"; text: string; username: string };

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const MENTION_RE = /(^|[^A-Za-z0-9_.@/:-])@([A-Za-z0-9_.-]{3,32})/g;

/** Usernames @mentioned in `body` (lowercased, unique), in order of first appearance. */
export function extractMentions(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    // A trailing dot or dash is punctuation ("thanks @bob."), not part of the name.
    const name = m[2].replace(/[.-]+$/, "").toLowerCase();
    if (name.length >= 3 && !out.includes(name)) out.push(name);
  }
  return out;
}

function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const count = (s: string, c: string) => s.split(c).length - 1;

/** Drops trailing punctuation; keeps a ")" only when it closes a "(" inside the URL. */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url[url.length - 1];
    if (last !== undefined && ".,;:!?]}".includes(last)) url = url.slice(0, -1);
    else if (last === ")" && count(url, ")") > count(url, "(")) url = url.slice(0, -1);
    else return url;
  }
}

/** Splits text into plain/link segments. */
function linkify(text: string): ChatSegment[] {
  const out: ChatSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const url = trimUrl(m[0]);
    const href = safeHref(url);
    if (!href) continue;
    if (start > last) out.push({ type: "text", text: text.slice(last, start) });
    out.push({ type: "link", text: url, href });
    last = start + url.length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

/**
 * @param members usernames (any case) of the league's members: only these @mentions are highlighted.
 */
export function renderChatText(body: string, members: Iterable<string> = []): ChatSegment[] {
  const known = new Map<string, string>();
  for (const u of members) known.set(u.toLowerCase(), u);
  const out: ChatSegment[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push(...linkify(buf));
    buf = "";
  };
  let i = 0;
  const re = new RegExp(MENTION_RE.source, "g");
  for (const m of body.matchAll(re)) {
    const lead = m[1];
    const raw = m[2].replace(/[.-]+$/, "");
    const real = known.get(raw.toLowerCase());
    if (!real) continue;
    const start = (m.index ?? 0) + lead.length;
    buf += body.slice(i, start);
    flush();
    out.push({ type: "mention", text: `@${raw}`, username: real });
    i = start + 1 + raw.length;
  }
  buf += body.slice(i);
  flush();
  return out;
}

/** Trims and validates a body. Returns the cleaned body or an error message. */
export function cleanBody(raw: unknown): { ok: true; body: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "Write a message first." };
  const body = raw.replace(/\r\n/g, "\n").trim();
  if (!body) return { ok: false, error: "Write a message first." };
  if (body.length > MAX_BODY_LENGTH) return { ok: false, error: `Messages can be at most ${MAX_BODY_LENGTH} characters.` };
  return { ok: true, body };
}
