import { renderChatText } from "@/lib/chat/text";

/**
 * Renders a chat body. Everything is emitted as React text nodes (escaped by React) plus <a>
 * elements for http(s) links: there is deliberately no dangerouslySetInnerHTML anywhere.
 */
export function ChatText({ body, members }: { body: string; members: readonly string[] }) {
  return (
    <span className="whitespace-pre-wrap break-words">
      {renderChatText(body, members).map((seg, i) => {
        if (seg.type === "link") {
          return (
            <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline underline-offset-2">
              {seg.text}
            </a>
          );
        }
        if (seg.type === "mention") {
          return (
            <span key={i} className="rounded bg-primary/10 px-0.5 font-medium text-primary" data-mention={seg.username}>
              {seg.text}
            </span>
          );
        }
        return <span key={i}>{seg.text}</span>;
      })}
    </span>
  );
}
