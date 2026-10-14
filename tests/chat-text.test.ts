import { describe, expect, it } from "vitest";
import { MAX_BODY_LENGTH, cleanBody, extractMentions, renderChatText } from "@/lib/chat/text";

describe("renderChatText (sanitization: raw in, text nodes out)", () => {
  it("never produces markup: HTML stays a plain text segment, character for character", () => {
    const raw = `<script>alert("x")</script><img src=x onerror=alert(1)> & "quotes"`;
    expect(renderChatText(raw)).toEqual([{ type: "text", text: raw }]);
  });

  it("links only http(s) URLs; javascript:, data: and others stay text", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "ftp://example.com/file"]) {
      const segs = renderChatText(`click ${bad} now`);
      expect(segs.every((s) => s.type === "text")).toBe(true);
      expect(segs.map((s) => s.text).join("")).toBe(`click ${bad} now`);
    }
    const segs = renderChatText("see https://example.com/a?b=1&c=2 and http://foo.test");
    const links = segs.filter((s) => s.type === "link");
    expect(links.map((l) => (l as { href: string }).href)).toEqual(["https://example.com/a?b=1&c=2", "http://foo.test/"]);
  });

  it("keeps link text verbatim and drops trailing punctuation from the URL", () => {
    const segs = renderChatText("(read https://example.com/page.), then https://example.com/wiki/Foo_(bar)!");
    const links = segs.filter((s) => s.type === "link") as { text: string; href: string }[];
    expect(links.map((l) => l.text)).toEqual(["https://example.com/page", "https://example.com/wiki/Foo_(bar)"]);
    expect(segs.map((s) => s.text).join("")).toBe("(read https://example.com/page.), then https://example.com/wiki/Foo_(bar)!");
  });

  it("highlights @mentions only for known members (case-insensitive), not emails or unknown names", () => {
    const segs = renderChatText("hey @Bob and @nobody, mail me a@bob.com", ["bob", "carol"]);
    const mentions = segs.filter((s) => s.type === "mention") as { username: string; text: string }[];
    expect(mentions).toEqual([{ type: "mention", text: "@Bob", username: "bob" }]);
    expect(segs.map((s) => s.text).join("")).toBe("hey @Bob and @nobody, mail me a@bob.com");
  });

  it("does not treat a path like /@bob inside a URL as a mention", () => {
    const segs = renderChatText("https://social.example/@bob", ["bob"]);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("link");
  });

  it("round-trips arbitrary text (concatenated segments equal the input)", () => {
    const samples = ["", "plain", "@bob @bob @bob", "line1\nline2 https://a.co/x\n@carol!", "https://a.co https://b.co"];
    for (const s of samples) expect(renderChatText(s, ["bob", "carol"]).map((x) => x.text).join("")).toBe(s);
  });
});

describe("extractMentions", () => {
  it("returns unique lowercased usernames in order, ignoring emails and trailing punctuation", () => {
    expect(extractMentions("@Bob hi @carol. cc @bob; mail x@y.com")).toEqual(["bob", "carol"]);
    expect(extractMentions("no mentions here")).toEqual([]);
    expect(extractMentions("@ab too short")).toEqual([]);
  });
});

describe("cleanBody", () => {
  it("trims, normalizes newlines, and enforces 1..2000 characters", () => {
    expect(cleanBody("  hi \r\nthere  ")).toEqual({ ok: true, body: "hi \nthere" });
    expect(cleanBody("   ").ok).toBe(false);
    expect(cleanBody(42).ok).toBe(false);
    expect(cleanBody("x".repeat(MAX_BODY_LENGTH)).ok).toBe(true);
    expect(cleanBody("x".repeat(MAX_BODY_LENGTH + 1)).ok).toBe(false);
  });
});
