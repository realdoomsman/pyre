import { useState, type ReactNode } from "react";
import { AppSpec, MonetizationModel } from "@pyre/shared";
import type { AppSpec as Spec, MonetizationModel as Model } from "@pyre/shared";
import { Button, Chip, Field, Input, Select, Skeleton, StatusLed, Textarea } from "../../ui/index.js";

const MODEL_LABEL: Record<Model, string> = {
  ONE_TIME: "One-time purchase (USDG)",
  SUBSCRIPTION: "Monthly subscription (USDG)",
  PAY_PER_REQUEST: "Pay per request (USDG per call)",
  ADS: "Free with ads",
  HOLDER_TIER: "Free, pro tier for holders",
};

const TEMPLATES: Array<{ id: Spec["template"]; label: string }> = [
  { id: "WEB_TOOL", label: "Web tool — utility / SaaS-style page" },
  { id: "GAME", label: "Game — canvas or DOM game loop" },
  { id: "AGENT_API", label: "Agent API — paid endpoint + docs page" },
];

/** The intake agent is drafting: the draft sits in DRAFT and the page polls. */
export const BriefGenerating = ({ ticker }: { ticker: string }) => (
  <div className="flex flex-col gap-5" role="status" aria-live="polite">
    <div className="flex items-center justify-between rounded-card border border-line bg-mono-bg px-4 py-3">
      <div>
        <div className="eyebrow">intake · ${ticker || "COIN"}</div>
        <p className="text-14 text-ink">The intake agent is drafting the brief from your prompt.</p>
      </div>
      <StatusLed tone="build" label="Drafting" />
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <Skeleton className="h-10" />
      <Skeleton className="h-10" />
    </div>
    <Skeleton lines={4} />
    <p className="small text-ink-3">Usually under a minute. Costs the platform a few cents; you are not charged.</p>
  </div>
);

interface Props {
  spec: Spec;
  ticker: string;
  busy: boolean;
  error: string | null;
  onApprove: (spec: Spec) => void;
  onBack: () => void;
}

export const StepBrief = ({ spec: initial, ticker, busy, error, onApprove, onBack }: Props) => {
  const [spec, setSpec] = useState<Spec>(initial);
  const [issues, setIssues] = useState<string[]>([]);
  const patch = (p: Partial<Spec>) => setSpec((s) => ({ ...s, ...p }));

  const approve = () => {
    const parsed = AppSpec.safeParse(spec);
    if (!parsed.success) {
      setIssues(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
      return;
    }
    setIssues([]);
    onApprove(parsed.data);
  };

  const priced = spec.monetization.model !== "ADS" && spec.monetization.model !== "HOLDER_TIER";

  return (
    <div className="flex flex-col gap-7">
      <div className="rounded-card border border-[color-mix(in_oklab,var(--color-build)_30%,var(--color-line))] bg-[color-mix(in_oklab,var(--color-build)_6%,var(--color-surface))] px-4 py-3">
        <div className="eyebrow mb-1 text-build">This is what buyers fund</div>
        <p className="text-14 text-ink-2">
          The brief is pinned to the <span className="num text-ink">${ticker}</span> coin page and handed to the build agent verbatim. Anyone buying the coin can read exactly what
          their fees pay for. Edit anything; approve when it says what you mean.
        </p>
      </div>

      <Section title="Identity">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title">
            <Input value={spec.title} onChange={(e) => patch({ title: e.target.value })} maxLength={80} />
          </Field>
          <Field label="Template">
            <Select value={spec.template} onChange={(e) => patch({ template: e.target.value as Spec["template"] })}>
              {TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="One-liner" hint="Shown on the coin card and in the app store." meta={`${spec.oneLiner.length}/160`}>
          <Input value={spec.oneLiner} onChange={(e) => patch({ oneLiner: e.target.value })} maxLength={160} />
        </Field>
      </Section>

      <Section title="What it does">
        <Textarea value={spec.whatItDoes} onChange={(e) => patch({ whatItDoes: e.target.value })} rows={5} maxLength={1200} aria-label="What it does" />
      </Section>

      <Section title="Who pays, and how">
        <Field label="Who pays">
          <Textarea value={spec.whoPays} onChange={(e) => patch({ whoPays: e.target.value })} rows={3} maxLength={600} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
          <Field label="Model">
            <Select
              value={spec.monetization.model}
              onChange={(e) => {
                const model = e.target.value as Model;
                const keepPrice = model !== "ADS" && model !== "HOLDER_TIER";
                patch({ monetization: { ...spec.monetization, model, priceUsd: keepPrice ? spec.monetization.priceUsd : null } });
              }}
            >
              {MonetizationModel.options.map((m) => (
                <option key={m} value={m}>
                  {MODEL_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Price">
            <Input
              mono
              prefix="$"
              type="number"
              min={0}
              max={10_000}
              step="0.01"
              inputMode="decimal"
              disabled={!priced}
              value={spec.monetization.priceUsd ?? ""}
              onChange={(e) => patch({ monetization: { ...spec.monetization, priceUsd: e.target.value === "" ? null : Number(e.target.value) } })}
            />
          </Field>
        </div>
        <Field label="Price description" hint="What the price buys, in the app's own words.">
          <Input value={spec.monetization.priceDescription} onChange={(e) => patch({ monetization: { ...spec.monetization, priceDescription: e.target.value } })} maxLength={200} />
        </Field>
      </Section>

      <Section title="MVP">
        <ListEditor label="Feature" items={spec.mvp} max={8} placeholder="One shippable feature per line" onChange={(mvp) => patch({ mvp })} />
      </Section>

      <Section title="Out of scope">
        <ListEditor label="Out of scope" items={spec.outOfScope} max={8} placeholder="What v1 deliberately skips" onChange={(outOfScope) => patch({ outOfScope })} />
      </Section>

      <Section title="Holder tier">
        <label className="flex items-center gap-3 text-14">
          <input
            type="checkbox"
            checked={spec.holderTier.enabled}
            onChange={(e) => patch({ holderTier: { ...spec.holderTier, enabled: e.target.checked } })}
            className="h-4 w-4 accent-(--color-accent)"
          />
          Holders of <span className="num">${ticker}</span> get extra features
        </label>
        {spec.holderTier.enabled && (
          <div className="grid gap-4 sm:grid-cols-[180px_minmax(0,1fr)]">
            <Field label="Minimum holding" hint="Whole tokens">
              <Input
                mono
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                value={spec.holderTier.minHoldTokens ?? ""}
                onChange={(e) => patch({ holderTier: { ...spec.holderTier, minHoldTokens: e.target.value === "" ? null : Math.floor(Number(e.target.value)) } })}
              />
            </Field>
            <ListEditor label="Perk" items={spec.holderTier.perks} max={6} placeholder="A product feature, never a payout" onChange={(perks) => patch({ holderTier: { ...spec.holderTier, perks } })} />
          </div>
        )}
      </Section>

      {spec.risks.length > 0 && (
        <Section title="Risks the agent flagged">
          <ul className="flex flex-wrap gap-2">
            {spec.risks.map((r) => (
              <li key={r}>
                <Chip tone="warn">{r}</Chip>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(issues.length > 0 || error) && (
        <div role="alert" className="rounded-card border border-[color-mix(in_oklab,var(--color-danger)_40%,transparent)] px-4 py-3 text-13 text-danger">
          {error && <p>{error}</p>}
          {issues.map((i) => (
            <p key={i} className="num">
              {i}
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-col-reverse gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          Back to coin
        </Button>
        <Button size="lg" onClick={approve} loading={busy}>
          Approve brief
        </Button>
      </div>
    </div>
  );
};

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-3">
    <h3 className="eyebrow">{title}</h3>
    {children}
  </section>
);

const ListEditor = ({
  label,
  items,
  max,
  placeholder,
  onChange,
}: {
  label: string;
  items: string[];
  max: number;
  placeholder: string;
  onChange: (items: string[]) => void;
}) => {
  const set = (i: number, v: string) => onChange(items.map((it, j) => (j === i ? v : it)));
  return (
    <ol className="flex flex-col gap-2">
      {items.map((it, i) => (
        <li key={i} className="flex items-center gap-2">
          <span className="num w-5 shrink-0 text-right text-12 text-ink-3">{i + 1}</span>
          <Input value={it} onChange={(e) => set(i, e.target.value)} maxLength={200} placeholder={placeholder} aria-label={`${label} ${i + 1}`} />
          <Button variant="icon" size="sm" label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </Button>
        </li>
      ))}
      {items.length < max && (
        <li>
          <Button variant="ghost" size="sm" onClick={() => onChange([...items, ""])}>
            + Add {label.toLowerCase()}
          </Button>
        </li>
      )}
    </ol>
  );
};
