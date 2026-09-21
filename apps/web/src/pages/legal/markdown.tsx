import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/** `**bold**`, `` `code` ``, `[label](href)`, `_emphasis_` — first match wins, left to right. */
const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|_([^_\n]+)_/g;

const LINK = "text-accent underline decoration-[color-mix(in_oklab,var(--color-accent)_45%,transparent)] underline-offset-[3px] hover:decoration-accent";

const inline = (text: string, key: string): ReactNode[] => {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(text); m !== null; m = INLINE.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1] !== undefined)
      out.push(
        <strong key={k} className="font-semibold text-ink">
          {m[1]}
        </strong>,
      );
    else if (m[2] !== undefined)
      out.push(
        <code key={k} className="num rounded-[4px] border border-line bg-fill px-1 py-px text-[0.86em]">
          {m[2]}
        </code>,
      );
    else if (m[3] !== undefined && m[4] !== undefined) {
      const href = m[4];
      out.push(
        href.startsWith("/") ? (
          <Link key={k} to={href} className={LINK}>
            {m[3]}
          </Link>
        ) : (
          <a key={k} href={href} target="_blank" rel="noreferrer noopener" className={LINK}>
            {m[3]}
          </a>
        ),
      );
    } else out.push(<em key={k}>{m[5]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
};

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+\.\s+(.*)$/;

/** Section headings double as anchors so a clause can be linked. */
const anchor = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export interface Heading {
  id: string;
  text: string;
}

/** Top-level `##` headings, for the table of contents. */
export const headingsOf = (source: string): Heading[] =>
  source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => /^##\s+(.*)$/.exec(l.trimEnd()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ id: anchor(m[1]), text: m[1] }));

/**
 * Dependency-free renderer for the legal docs in `public/legal`: headings, paragraphs,
 * `-` bullets, numbered steps, and the inline marks above. Anything else renders as text.
 * Prose is set in the sans at 16/1.7 with a 68ch measure; the H1 is the only serif.
 */
export const Markdown = ({ source }: { source: string }) => {
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let items: string[] = [];
  let ordered = false;

  const flush = () => {
    if (para.length > 0) {
      const text = para.join(" ");
      blocks.push(
        <p key={`p${blocks.length}`} className="mb-4 text-[16px] leading-[1.7] text-ink-2">
          {inline(text, `p${blocks.length}`)}
        </p>,
      );
      para = [];
    }
    if (items.length > 0) {
      const key = `l${blocks.length}`;
      const lis = items.map((it, n) => (
        <li key={`${key}-${n}`} className="mb-2 pl-1.5 text-[16px] leading-[1.7] text-ink-2 marker:text-ink-3">
          {inline(it, `${key}-${n}`)}
        </li>
      ));
      blocks.push(
        ordered ? (
          <ol key={key} className="mb-5 list-decimal pl-6 marker:num">
            {lis}
          </ol>
        ) : (
          <ul key={key} className="mb-5 list-disc pl-6">
            {lis}
          </ul>
        ),
      );
      items = [];
    }
  };

  for (const raw of source.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const key = `h${blocks.length}`;
      const body = inline(heading[2], key);
      if (heading[1].length === 1) {
        blocks.push(
          <h1 key={key} className="display mb-6 text-48 text-ink sm:text-64">
            {body}
          </h1>,
        );
      } else if (heading[1].length === 2) {
        blocks.push(
          <h2 key={key} id={anchor(heading[2])} className="mb-3 mt-10 scroll-mt-24 border-t border-line pt-6 text-22 font-semibold text-ink">
            {body}
          </h2>,
        );
      } else {
        blocks.push(
          <h3 key={key} className="mb-2 mt-6 text-15 font-semibold text-ink">
            {body}
          </h3>,
        );
      }
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const isOrdered = !bullet;
      if (items.length > 0 && ordered !== isOrdered) flush();
      if (para.length > 0) flush();
      ordered = isOrdered;
      items.push((bullet ? bullet[1] : numbered![1]).trim());
      continue;
    }
    // Continuation line of a list item or a paragraph.
    if (items.length > 0) items[items.length - 1] += ` ${line.trim()}`;
    else para.push(line.trim());
  }
  flush();

  return <div className="max-w-[68ch]">{blocks}</div>;
};
