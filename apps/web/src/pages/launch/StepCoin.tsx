import { useRef, useState, type FormEvent } from "react";
import { CreateLaunchBody, slugify } from "@pyre/shared";
import type { CreateLaunchBody as Body, Launchpad } from "@pyre/shared";
import { isHttpError, uploadCoinImage } from "../../api/client.js";
import { useVenues } from "../../lib/venue.js";
import { Avatar, Button, Field, Input, Textarea, toast } from "../../ui/index.js";
import { ImageCrop, type ImageCropHandle } from "./ImageCrop.js";
import type { CoinDraft } from "./preview.js";
import { VenuePicker } from "./VenuePicker.js";

interface Props {
  draft: CoinDraft;
  onChange: (draft: CoinDraft) => void;
  onSubmit: (body: Body) => void;
  busy: boolean;
  /** Intake moderation refused the previous attempt — shown above the form, form stays editable. */
  rejection: string | null;
  /** Forking `$TICKER`: the venue is the parent's and cannot be changed. */
  forking: { ticker: string; launchpad: Launchpad } | null;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export const StepCoin = ({ draft, onChange, onSubmit, busy, rejection, forking }: Props) => {
  const [pending, setPending] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof CoinDraft, string>>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const cropper = useRef<ImageCropHandle>(null);
  const venues = useVenues();

  const patch = (p: Partial<CoinDraft>) => onChange({ ...draft, ...p });
  const venueOff = venues.data?.some((v) => v.launchpad === draft.launchpad && !v.enabled) ?? false;

  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("That file is not an image.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error("Images must be under 8 MB.");
      return;
    }
    setPending(file);
  };

  /** Uploads a cropped file; resolves the hosted URL or null after a toast. */
  const upload = async (file: File): Promise<string | null> => {
    setUploading(true);
    try {
      const url = await uploadCoinImage(file);
      patch({ imageUrl: url });
      setPending(null);
      setErrors((e) => ({ ...e, imageUrl: undefined }));
      return url;
    } catch (err) {
      toast.error(isHttpError(err) ? err.message : "Upload failed. Try again.");
      return null;
    } finally {
      setUploading(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (uploading) return;
    // A crop the user picked but never confirmed (Enter in a field, or straight to the submit
    // button) is applied here instead of failing validation with the cropper still open.
    let imageUrl = draft.imageUrl;
    if (pending && cropper.current) {
      let cropped: File;
      try {
        cropped = await cropper.current.crop();
      } catch {
        toast.error("Could not read that image. Choose another.");
        return;
      }
      const url = await upload(cropped);
      if (!url) return;
      imageUrl = url;
    }
    const candidate = {
      launchpad: draft.launchpad,
      name: draft.name.trim(),
      ticker: draft.ticker.trim().toUpperCase(),
      imageUrl,
      prompt: draft.prompt.trim(),
      twitter: draft.twitter.trim() || undefined,
      website: draft.website.trim() || undefined,
    };
    const parsed = CreateLaunchBody.safeParse(candidate);
    if (!parsed.success) {
      const next: Partial<Record<keyof CoinDraft, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof CoinDraft;
        next[key] ??= MESSAGES[key] ?? issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    onSubmit(parsed.data);
  };

  const slug = slugify(draft.name);

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-6" noValidate>
      {rejection && (
        <div role="alert" className="rounded-card border border-[color-mix(in_oklab,var(--color-danger)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-danger)_8%,transparent)] px-4 py-3 text-14">
          <div className="eyebrow mb-1 text-danger">Launch refused</div>
          <p className="text-ink">{rejection}</p>
          <p className="small mt-1 text-ink-2">Nothing was created and nothing was charged.</p>
        </div>
      )}
      {forking && (
        <p className="small rounded-card border border-line bg-fill px-4 py-3 text-ink-2">
          Forking <span className="num text-ink">${forking.ticker}</span>: the parent's spec is the starting prompt and 10% of this coin's creator fees flow upstream, forever.
        </p>
      )}

      <Field label="Where does the coin launch?" required hint={venueOff ? "That venue is paused right now; pick another." : "The chain and launchpad cannot be changed after launch."}>
        <VenuePicker
          value={draft.launchpad}
          onChange={(launchpad) => patch({ launchpad })}
          venues={venues.data}
          locked={forking ? { launchpad: forking.launchpad, reason: `A fork launches where its parent did.` } : null}
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Field label="Name" required error={errors.name} hint={slug && draft.name ? <>Lives at <span className="num">{slug}.pyre.fun</span></> : "2–32 characters"}>
          <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} maxLength={32} placeholder="Deadline Radar" autoComplete="off" invalid={!!errors.name} />
        </Field>
        <Field label="Ticker" required error={errors.ticker} hint="2–10 letters or digits">
          <Input
            mono
            prefix="$"
            value={draft.ticker}
            onChange={(e) => patch({ ticker: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) })}
            maxLength={10}
            placeholder="RADAR"
            autoComplete="off"
            invalid={!!errors.ticker}
          />
        </Field>
      </div>

      <Field label="Image" required error={errors.imageUrl} hint="Square, written to the chain at launch. PNG, JPG or GIF up to 8 MB.">
        {pending ? (
          <ImageCrop ref={cropper} file={pending} busy={uploading} onCrop={(f) => void upload(f)} onCancel={() => setPending(null)} />
        ) : (
          <div className="flex items-center gap-4">
            <Avatar src={draft.imageUrl || null} name={draft.ticker || draft.name || "?"} size={72} shape="square" />
            <div className="flex flex-col gap-2">
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="sr-only"
                onChange={(e) => {
                  pick(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <Button type="button" variant="secondary" size="sm" onClick={() => fileInput.current?.click()}>
                {draft.imageUrl ? "Replace image" : "Choose image"}
              </Button>
              {draft.imageUrl && (
                <Button type="button" variant="ghost" size="sm" onClick={() => patch({ imageUrl: "" })}>
                  Remove
                </Button>
              )}
            </div>
          </div>
        )}
      </Field>

      <Field
        label="What should the agent build?"
        required
        error={errors.prompt}
        hint="One or two sentences. The intake agent turns this into a full brief you can edit in the next step."
        meta={<span className={draft.prompt.length > 4000 ? "text-danger" : undefined}>{draft.prompt.length}/4000</span>}
      >
        <Textarea
          value={draft.prompt}
          onChange={(e) => patch({ prompt: e.target.value })}
          rows={4}
          maxLength={4000}
          placeholder="A tool that watches public GitHub repos and texts me the day before a release deadline slips."
          invalid={!!errors.prompt}
        />
      </Field>

      <details className="group">
        <summary className="small cursor-pointer select-none text-ink-2 hover:text-ink">
          Socials <span className="text-ink-3">(optional)</span>
        </summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="X profile" error={errors.twitter}>
            <Input value={draft.twitter} onChange={(e) => patch({ twitter: e.target.value })} placeholder="https://x.com/yourcoin" inputMode="url" invalid={!!errors.twitter} />
          </Field>
          <Field label="Website" error={errors.website}>
            <Input value={draft.website} onChange={(e) => patch({ website: e.target.value })} placeholder="https://" inputMode="url" invalid={!!errors.website} />
          </Field>
        </div>
      </details>

      <div className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="small text-ink-3">Name, ticker and image are written to the chain and cannot be changed after launch.</p>
        <Button type="submit" size="lg" loading={busy} disabled={uploading || venueOff}>
          Draft the agent brief
        </Button>
      </div>
    </form>
  );
};

const MESSAGES: Partial<Record<keyof CoinDraft, string>> = {
  name: "Give the coin a name between 2 and 32 characters.",
  ticker: "A ticker is 2–10 uppercase letters or digits.",
  imageUrl: "Add a square image.",
  prompt: "Say what the agent should build — at least 20 characters.",
  twitter: "That is not a valid URL.",
  website: "That is not a valid URL.",
};
