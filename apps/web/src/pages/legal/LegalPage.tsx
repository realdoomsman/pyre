import { useEffect } from "react";
import { NavLink, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTheme } from "../../lib/theme.js";
import { Button, EmptyState, Skeleton, cx } from "../../ui/index.js";
import { Markdown, headingsOf } from "./markdown.js";

const DOCS: Record<string, { title: string; label: string; blurb: string }> = {
  terms: { title: "Terms of Service", label: "Terms", blurb: "What Pyre does and what you agree to." },
  privacy: { title: "Privacy Policy", label: "Privacy", blurb: "What we store and who sees it." },
  "content-policy": { title: "Content Policy", label: "Content policy", blurb: "What can and cannot be launched." },
};

const ORDER = ["terms", "privacy", "content-policy"] as const;

const LAST_UPDATED = /^_Last updated:\s*(.+?)_\s*$/m;

export const LegalPage = () => {
  useTheme("light");
  const { doc } = useParams<{ doc: string }>();
  const key = doc && DOCS[doc] ? doc : null;

  const q = useQuery({
    queryKey: ["legal", key],
    queryFn: async () => {
      const res = await fetch(`/legal/${key}.md`, { headers: { accept: "text/markdown, text/plain" } });
      if (!res.ok) throw new Error(`could not load this document (${res.status})`);
      return res.text();
    },
    enabled: key !== null,
    staleTime: Infinity,
  });

  useEffect(() => {
    document.title = key ? `Pyre — ${DOCS[key].title}` : "Pyre — document not found";
  }, [key]);

  // The date lives in the markdown; hoist it into the eyebrow rather than printing it twice.
  const match = q.data ? LAST_UPDATED.exec(q.data) : null;
  const updated = match?.[1] ?? null;
  const source = q.data && match ? q.data.replace(match[0], "").trimStart() : q.data;
  const headings = source ? headingsOf(source) : [];

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-10 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-16">
      <nav aria-label="Legal documents" className="flex flex-col gap-6 lg:sticky lg:top-24 lg:self-start">
        <div>
          <div className="eyebrow mb-2">Legal</div>
          <ul className="flex flex-row gap-1 overflow-x-auto lg:flex-col">
            {ORDER.map((k) => (
              <li key={k}>
                <NavLink
                  to={`/legal/${k}`}
                  className={({ isActive }) =>
                    cx(
                      "block whitespace-nowrap rounded-control px-2.5 py-1.5 text-14 transition-colors duration-(--duration-ui)",
                      isActive ? "bg-accent-wash font-medium text-accent" : "text-ink-2 hover:bg-fill hover:text-ink",
                    )
                  }
                >
                  {DOCS[k].label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
        {headings.length > 0 && (
          <div className="hidden lg:block">
            <div className="eyebrow mb-2">Contents</div>
            <ol className="flex flex-col gap-1 border-l border-line">
              {headings.map((h) => (
                <li key={h.id}>
                  <a href={`#${h.id}`} className="block -ml-px border-l border-transparent py-0.5 pl-3 text-13 text-ink-3 transition-colors duration-(--duration-ui) hover:border-accent hover:text-ink">
                    {h.text}
                  </a>
                </li>
              ))}
            </ol>
          </div>
        )}
      </nav>

      <article className="min-w-0">
        {key === null ? (
          <EmptyState
            title="No such document"
            body="The legal documents are the terms, the privacy policy and the content policy."
            action={
              <Button variant="secondary" size="sm" href="/legal/terms">
                Read the terms
              </Button>
            }
          />
        ) : q.isPending ? (
          <div className="max-w-[68ch] space-y-4">
            <Skeleton className="h-14 w-72" />
            <Skeleton className="h-4 w-40" />
            <Skeleton lines={6} />
            <Skeleton lines={5} />
          </div>
        ) : q.isError || !source ? (
          <p role="alert" className="text-danger">
            {q.error instanceof Error ? q.error.message : "This document could not be loaded."}
          </p>
        ) : (
          <>
            <div className="eyebrow mb-4">
              {DOCS[key].blurb}
              {updated && <span className="ml-2 normal-case tracking-normal text-ink-3">· Last updated {updated}</span>}
            </div>
            <Markdown source={source} />
            <footer className="mt-12 max-w-[68ch] border-t border-line pt-5 text-13 text-ink-3">
              Questions about any of this go to the addresses in the{" "}
              <NavLink to="/legal/privacy" className="text-accent underline underline-offset-[3px]">
                privacy policy
              </NavLink>
              . These pages are the served copies; the same text lives in the public repository under <span className="num">docs/</span>.
            </footer>
          </>
        )}
      </article>
    </div>
  );
};
