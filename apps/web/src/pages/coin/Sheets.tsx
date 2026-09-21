import { useState, type FormEvent } from "react";
import type { AppDetailDto } from "@pyre/shared";
import { env } from "../../env.js";
import { formatPct, formatUsdCompact } from "../../lib/format.js";
import { Button, Field, Input, Select, Sheet, Textarea, toast } from "../../ui/index.js";
import { useReport, type ReportBody } from "./queries.js";
import { describeError } from "./trade.js";

const KINDS: Array<{ id: ReportBody["kind"]; label: string }> = [
  { id: "ABUSE", label: "Abuse or scam" },
  { id: "DMCA", label: "Copyright (DMCA)" },
  { id: "IMPERSONATION", label: "Impersonation" },
  { id: "OTHER", label: "Something else" },
];

export const ReportSheet = ({ app, open, onClose }: { app: AppDetailDto; open: boolean; onClose: () => void }) => {
  const report = useReport();
  const [reporter, setReporter] = useState("");
  const [kind, setKind] = useState<ReportBody["kind"]>("ABUSE");
  const [details, setDetails] = useState("");
  const valid = reporter.trim().length >= 3 && details.trim().length >= 10;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    try {
      await report.mutateAsync({ slug: app.slug, reporter: reporter.trim(), kind, details: details.trim() });
      toast.success("Report received", { description: "Thanks — a human will look at it." });
      setDetails("");
      onClose();
    } catch (err) {
      toast.error("Could not send report", { description: describeError(err) });
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      eyebrow={`$${app.ticker}`}
      title="Report this coin"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" type="submit" form="report-form" disabled={!valid} loading={report.isPending}>
            Send report
          </Button>
        </div>
      }
    >
      <form id="report-form" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Your contact" hint="Email or X handle, so we can follow up.">
          <Input value={reporter} onChange={(e) => setReporter(e.target.value)} placeholder="email or @handle" maxLength={120} autoComplete="email" />
        </Field>
        <Field label="Reason">
          <Select value={kind} onChange={(e) => setKind(e.target.value as ReportBody["kind"])}>
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Details">
          <Textarea rows={5} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="What happened, with links if you have them." maxLength={4000} />
        </Field>
      </form>
    </Sheet>
  );
};

const copy = async (text: string, label: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Clipboard blocked", { description: text });
  }
};

export const ShareSheet = ({ app, open, onClose }: { app: AppDetailDto; open: boolean; onClose: () => void }) => {
  const url = `${env.siteUrl}/c/${app.slug}`;
  const line = `$${app.ticker} on Pyre — ${formatUsdCompact(BigInt(Math.round(app.mcapUsd * 1e6)))} mcap, ${formatPct(app.burnedPct / 100, 2)} of supply burned by app revenue. not financial advice.`;
  const intent = `https://x.com/intent/post?${new URLSearchParams({ text: line, url }).toString()}`;
  const card = `/c/${app.slug}/card`;
  return (
    <Sheet open={open} onClose={onClose} eyebrow={`$${app.ticker}`} title="Share">
      <div className="flex flex-col gap-4">
        <p className="small text-ink-2">{line}</p>
        <Field label="Link">
          <div className="flex gap-2">
            <Input mono readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
            <Button variant="secondary" onClick={() => copy(url, "Link")}>
              Copy
            </Button>
          </div>
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" href={intent} target="_blank" rel="noreferrer">
            Post on X
          </Button>
          <Button variant="secondary" onClick={() => copy(`${line} ${url}`, "Post")}>
            Copy post
          </Button>
          <Button variant="secondary" href={card} target="_blank" rel="noreferrer">
            Open share card
          </Button>
          {app.tokenAddress && (
            <Button variant="ghost" onClick={() => copy(app.tokenAddress!, "Contract address")}>
              Copy CA
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  );
};
