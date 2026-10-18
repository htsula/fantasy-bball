import type { Page, Response } from "@playwright/test";

/** Debug aid (SIM_DIAG=1): first difference between the server HTML of a load and the hydrated DOM (tags and text). */
export async function hydrationDiff(resp: Response, page: Page): Promise<string> {
  const html = await resp.text();
  const tokens = (h: string) =>
    h
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(\/?[a-zA-Z0-9-]+)[^>]*>/g, "<$1>")
      .replace(/&amp;/g, "&")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .split(/(<[^>]+>)/)
      .map((t) => t.trim())
      .filter(Boolean);
  const a = tokens(html.slice(html.indexOf("<body")));
  const dom = await page.evaluate(() => {
    const c = document.body.cloneNode(true) as HTMLElement;
    c.querySelectorAll("script,style,next-route-announcer").forEach((n) => n.remove());
    return c.outerHTML;
  });
  const b = tokens(dom);
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return `DIFF at token ${k}/${a.length}/${b.length}: server ${JSON.stringify(a.slice(Math.max(0, k - 6), k + 8))} client ${JSON.stringify(b.slice(Math.max(0, k - 6), k + 8))}`;
}
