import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { formatCount, formatEth, formatPct, formatTokenUnits, formatUsd, formatUsdCompact, timeAgo } from "../../lib/format.js";
import {
  Address,
  Avatar,
  Button,
  Card,
  CardHeader,
  Chip,
  CommandK,
  ConsoleFrame,
  EmptyState,
  EthFlow,
  Field,
  GraduationRing,
  HeatGauge,
  Ignition,
  Input,
  Kbd,
  NumberFlow,
  Progress,
  ProofStrip,
  Select,
  Sheet,
  Skeleton,
  Sparkline,
  StatusLed,
  Table,
  Tabs,
  Textarea,
  TickFlash,
  Toaster,
  Tooltip,
  UsdFlow,
  panelId,
  toast,
  useCommandK,
  type ConsoleRow,
  type IgnitionTick,
  type LedTone,
  type ChipTone,
} from "../../ui/index.js";

/*
 * /_ui — the visual acceptance surface for the design system. Every primitive
 * in every state, on synthetic data. Dev builds only, never linked from the
 * product; page agents use it as the reference while they build.
 */

const TREASURY = "0x84F8E5a324466Deb7447048C014CF0245ce04afA";
const TX = "0x9c2e1a7f4b8d3c6e5f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6";

const Section = ({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) => (
  <section id={id} className="scroll-mt-20 border-t border-line py-10">
    <div className="mb-6 flex items-baseline justify-between gap-4">
      <h2 className="h2">{title}</h2>
      {note && <p className="small max-w-md text-right text-ink-3">{note}</p>}
    </div>
    {children}
  </section>
);

const Row = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <div className={`flex flex-wrap items-center gap-3 ${className}`}>{children}</div>
);

const Label = ({ children }: { children: ReactNode }) => <div className="eyebrow mb-2">{children}</div>;

const Swatch = ({ name, token, hex }: { name: string; token: string; hex?: string }) => (
  <div className="flex flex-col gap-1.5">
    <div className="h-14 w-full rounded-control border border-line" style={{ background: `var(${token})` }} />
    <div className="text-12 font-medium">{name}</div>
    <div className="num text-12 text-ink-3">{hex ?? token}</div>
  </div>
);

const SERIES_UP = [3, 4, 3.5, 5, 6, 5.5, 7, 8.5, 8, 9.5, 11, 12];
const SERIES_DOWN = [12, 11, 11.5, 9, 8, 8.5, 6, 5, 5.5, 4, 3.5, 3];

interface LedgerRow {
  id: string;
  at: number;
  coin: string;
  burnedUnits: bigint;
  pct: number;
  ethWei: bigint;
  tx: string;
}

const useTicking = (every: number) => {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), every);
    return () => clearInterval(t);
  }, [every]);
  return tick;
};

export const UiGallery = () => {
  useEffect(() => {
    document.title = "UI — Pyre";
  }, []);
  // The page mounts after the hash is applied; honour `#section` links ourselves.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView({ behavior: "instant", block: "start" });
  }, []);

  // Live numbers for the odometer / flash demos.
  const tick = useTicking(1800);
  const ethBurnedWei = 12_483_000_000_000_000_000n + BigInt(tick) * 21_000_000_000_000_000n;
  const appsLive = 41 + (tick % 3);
  const agentHours = 1_206 + tick * 2;
  const mcapMicros = 184_320_000_000n + BigInt(tick % 5) * 1_950_000_000n - BigInt(tick % 3) * 2_100_000_000n;

  // Heat gauge.
  const [heat, setHeat] = useState(0.62);
  // Tabs.
  const [tab, setTab] = useState("build");
  // Sheet / CommandK / Ignition.
  const [sheet, setSheet] = useState(false);
  const [cmd, setCmd] = useState(false);
  const toggleCmd = useCallback(() => setCmd((v) => !v), []);
  useCommandK(toggleCmd);
  const [ignition, setIgnition] = useState(false);
  const [ticks, setTicks] = useState<IgnitionTick[]>([]);
  useEffect(() => {
    if (!ignition) {
      setTicks([]);
      return;
    }
    let n = 0;
    const base = 12_341_000;
    const t = setInterval(() => {
      n += 1;
      setTicks((xs) => [
        ...xs,
        n === 1
          ? { id: `t${n}`, label: "launchToken()", detail: "sent", tone: "build" }
          : n === 14
            ? { id: `t${n}`, label: "curve funded", detail: "1,000,000,000 units", tone: "earn" }
            : { id: `t${n}`, label: `block ${(base + n).toLocaleString("en-US")}`, detail: "confirmed" },
      ]);
      if (n >= 16) clearInterval(t);
    }, 100);
    return () => clearInterval(t);
  }, [ignition]);

  // Console stream demo.
  const [rows, setRows] = useState<ConsoleRow[]>([]);
  useEffect(() => {
    const script: Array<[ConsoleRow["kind"], string]> = [
      ["think", "Reading the brief: a receipt-splitting app with holder-only export."],
      ["read", "template/src/App.tsx"],
      ["search", 'grep -r "HolderGate" packages/app-sdk/src'],
      ["edit", "src/App.tsx (+42 −7)"],
      ["edit", "functions/split.js (+31)"],
      ["read", "pyre.manifest.json"],
      ["deploy", "build ok · 148 kB · deployed to splitwise.pyre.fun"],
      ["error", "smoke: expected <h1> 'Splitwise' to match manifest name"],
      ["edit", "src/App.tsx (+1 −1)"],
      ["deploy", "build ok · 148 kB · redeployed"],
    ];
    let i = 0;
    const t = setInterval(() => {
      const [kind, text] = script[i % script.length];
      i += 1;
      setRows((xs) => [...xs.slice(-60), { id: `r${Date.now()}-${i}`, at: Date.now(), kind, text }]);
    }, 900);
    return () => clearInterval(t);
  }, []);

  const ledger: LedgerRow[] = useMemo(
    () =>
      Array.from({ length: 8 }, (_, i) => ({
        id: `b${i}`,
        at: Date.now() - i * 37 * 60_000,
        coin: ["$SPLIT", "$FORGE", "$LEDGR", "$RECPT"][i % 4],
        burnedUnits: BigInt(2_140_000 - i * 113_000) * 10n ** 18n,
        pct: 0.00214 - i * 0.000113,
        ethWei: 41_000_000_000_000_000n - BigInt(i) * 2_300_000_000_000_000n,
        tx: TX.slice(0, 60) + (i + 10).toString(16).padStart(4, "0"),
      })),
    [],
  );

  const commandItems = useMemo(
    () => [
      { id: "split", label: "Splitwise", hint: "$SPLIT", group: "Coins", keywords: ["split", "receipts"], onSelect: () => toast.info("Open $SPLIT") },
      { id: "forge", label: "Forgewatch", hint: "$FORGE", group: "Coins", keywords: ["forge"], onSelect: () => toast.info("Open $FORGE") },
      { id: "ledgr", label: "Ledgr", hint: "$LEDGR", group: "Coins", onSelect: () => toast.info("Open $LEDGR") },
      { id: "launch", label: "Launch a coin", hint: <Kbd keys={["L"]} />, group: "Actions", onSelect: () => toast.success("Launch tray") },
      { id: "account", label: "Account", group: "Actions", onSelect: () => toast.info("Account") },
      { id: "treasury", label: "Treasury", hint: "0x84F8…4afA", group: "Addresses", keywords: [TREASURY], onSelect: () => toast.info("Treasury") },
    ],
    [],
  );

  const chipTones: ChipTone[] = ["neutral", "accent", "build", "earn", "burn", "warn"];
  const ledTones: LedTone[] = ["live", "build", "idle", "warn", "error", "off"];

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <Toaster />
      <header className="glass sticky top-0 z-30 flex h-16 items-center justify-between border-b border-line px-6">
        <div className="flex items-baseline gap-3">
          <span className="display text-28">Pyre</span>
          <span className="eyebrow hidden sm:inline">design system · /_ui</span>
        </div>
        <div className="flex items-center gap-2">
          <ProofStrip
            compact
            className="mr-4 hidden md:flex"
            items={[
              { id: "burned", label: "ETH burned", value: Number(ethBurnedWei) / 1e18, format: { minimumFractionDigits: 3, maximumFractionDigits: 3 } },
              { id: "apps", label: "apps live", value: appsLive },
              { id: "hours", label: "agent-hours", value: agentHours },
            ]}
          />
        </div>
      </header>

      <main className="mx-auto max-w-[1200px] px-6 pb-32 pt-10">
        <div className="mb-10">
          <div className="eyebrow mb-3">Obsidian Temper · Instrument Serif + Geist + Geist Mono</div>
          <h1 className="display text-48 sm:text-88">
            Build. Earn. <em className="text-accent">Burn.</em>
          </h1>
          <p className="body mt-4 max-w-xl text-ink-2">
            Heat, not flame. Fire shown through consequence: supply shrinking, metal tempering, paper charring. One accent, mono numbers, hairlines,
            live proof.
          </p>
        </div>

        <Section id="color" title="Colour" note="Semantic roles only. Accent is for action and focus; build / earn / burn are the loop.">
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-5 lg:grid-cols-8">
            <Swatch name="canvas" token="--color-canvas" />
            <Swatch name="surface" token="--color-surface" />
            <Swatch name="raised" token="--color-raised" />
            <Swatch name="mono-bg" token="--color-mono-bg" />
            <Swatch name="ink" token="--color-ink" />
            <Swatch name="ink-2" token="--color-ink-2" />
            <Swatch name="ink-3" token="--color-ink-3" />
            <Swatch name="line-3" token="--color-line-3" />
            <Swatch name="accent" token="--color-accent" />
            <Swatch name="accent-strong" token="--color-accent-strong" />
            <Swatch name="accent-wash" token="--color-accent-wash" />
            <Swatch name="build" token="--color-build" />
            <Swatch name="earn" token="--color-earn" />
            <Swatch name="burn" token="--color-burn" />
            <Swatch name="warn" token="--color-warn" />
            <Swatch name="white-hot" token="--color-white-hot" />
            <Swatch name="temper-straw" token="--color-temper-straw" />
            <Swatch name="temper-bronze" token="--color-temper-bronze" />
            <Swatch name="temper-violet" token="--color-temper-violet" />
            <Swatch name="temper-blue" token="--color-temper-blue" />
            <Swatch name="tool-read" token="--color-tool-read" />
            <Swatch name="tool-edit" token="--color-tool-edit" />
            <Swatch name="tool-search" token="--color-tool-search" />
            <Swatch name="tool-think" token="--color-tool-think" />
          </div>
          <div className="mt-8">
            <Label>Heat ramp</Label>
          </div>
          <div className="grid grid-cols-6 gap-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Swatch key={i} name={`heat-${i}`} token={`--heat-${i}`} />
            ))}
          </div>
          <div className="mt-3 h-3 w-full rounded-pill" style={{ background: "linear-gradient(90deg, var(--heat-0), var(--heat-1), var(--heat-2), var(--heat-3), var(--heat-4), var(--heat-5))" }} />
        </Section>

        <Section id="type" title="Type" note="Serif display 400 with tightening tracking; UI weights capped at 600; mono +0.04em labels.">
          <div className="space-y-5">
            <div className="display text-88">Pyre 88</div>
            <div className="display text-64">Aa Obsidian and ink 64</div>
            <div className="display text-48">
              Every fee pays to <em>burn</em> 48
            </div>
            <div className="display text-36">Tempered violet on obsidian 36</div>
            <div className="text-28 font-medium">Geist 28 medium — coins that build apps</div>
            <div className="text-22 font-medium">Geist 22 medium — fees fund the build, fees fund the burn</div>
            <div className="h3">Geist 18 semibold — a card title</div>
            <p className="body max-w-2xl">
              Geist 15 body. Launch a coin and its trading fees pay an AI agent to build a real app. A quarter of every coin's fees buys and burns PYRE. Every
              number on this page is real, mono and tabular.
            </p>
            <p className="text-14 text-ink-2">Geist 14 secondary — metadata and helper text.</p>
            <p className="small text-ink-2">Geist 13 small — captions, table cells.</p>
            <p className="micro text-ink-3">Geist 12 micro — the smallest sans.</p>
            <div className="eyebrow">Geist Mono 12 eyebrow · +0.04em · uppercase</div>
            <div className="num text-22">0x84F8…4afA · 1,000,000,000 · 4.2000 ETH · $184,320.00</div>
            <div className="figure figure-hero">$1,240,893.16</div>
          </div>
        </Section>

        <Section id="buttons" title="Button" note="Pill primary, ghost secondary, danger, icon. Three sizes. Loading keeps width.">
          <Row>
            <Button>Launch a coin</Button>
            <Button variant="secondary">Trade on PONS</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="danger">Kill app</Button>
            <Button variant="icon" label="Copy">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" />
                <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" stroke="currentColor" />
              </svg>
            </Button>
          </Row>
          <Row className="mt-3">
            <Button size="sm">Small</Button>
            <Button size="md">Medium</Button>
            <Button size="lg">Large</Button>
            <Button loading>Signing</Button>
            <Button variant="secondary" loading>
              Quoting
            </Button>
            <Button disabled>Disabled</Button>
            <Button variant="secondary" disabled>
              Disabled
            </Button>
            <Button href="https://robinhoodchain.blockscout.com" target="_blank" rel="noreferrer" variant="secondary" iconRight={<span aria-hidden>↗</span>}>
              Explorer
            </Button>
          </Row>
        </Section>

        <Section id="chips" title="Chip" note="Tones, dot, mono, and toggles with aria-pressed.">
          <Row>
            {chipTones.map((t) => (
              <Chip key={t} tone={t}>
                {t}
              </Chip>
            ))}
            <Chip tone="build" dot>
              Building
            </Chip>
            <Chip tone="earn" dot>
              Earning
            </Chip>
            <Chip tone="burn" dot mono>
              burning
            </Chip>
            <Chip tone="accent" mono>
              $SPLIT
            </Chip>
            <Chip size="sm">small</Chip>
          </Row>
          <Row className="mt-3">
            <FilterChips />
          </Row>
        </Section>

        <Section id="cards" title="Card" note="Hairline surfaces. No shadows on dark; a 0-1-2 shadow on paper.">
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader eyebrow="surface" title="Default" description="Most panels." actions={<StatusLed tone="live" />} />
              <p className="small text-ink-2">Hairline border, 12px radius.</p>
            </Card>
            <Card tone="raised" interactive>
              <CardHeader eyebrow="raised · interactive" title="Hover me" actions={<Chip tone="accent">new</Chip>} />
              <p className="small text-ink-2">Lifts the hairline on hover.</p>
            </Card>
            <Card tone="inset" padding="sm">
              <div className="num text-12 text-ink-2">inset · mono-bg · dense</div>
            </Card>
            <Card tone="earn">
              <CardHeader eyebrow="earn" title="Fees claimed" />
              <div className="figure figure-lg text-earn">{formatUsd(4_213_550_000n)}</div>
            </Card>
            <Card tone="burn">
              <CardHeader eyebrow="burn" title="Supply destroyed" />
              <div className="figure figure-lg text-burn">{formatTokenUnits(2_140_000n * 10n ** 18n)}</div>
            </Card>
            <Card tone="build">
              <CardHeader eyebrow="build" title="Agent working" actions={<StatusLed tone="build" label="Building" />} />
              <Progress value={0.64} tone="build" />
            </Card>
            <Card ash>
              <CardHeader eyebrow="ash" title="Dormant coin" />
              <p className="small">No fees in 30 days.</p>
            </Card>
          </div>
        </Section>

        <Section id="tabs" title="Tabs" note="Roving tabindex; ← → Home End; sliding indicator.">
          <Tabs
            name="coin"
            value={tab}
            onChange={setTab}
            items={[
              { id: "build", label: "Build log", count: 128 },
              { id: "app", label: "App" },
              { id: "burn", label: "Burn ledger", count: 8 },
              { id: "holders", label: "Holders", count: "1.2k" },
              { id: "trades", label: "Trades" },
              { id: "thread", label: "Thread", disabled: true },
            ]}
          />
          <div id={panelId("coin", tab)} role="tabpanel" className="small mt-3 text-ink-2">
            Panel: {tab}
          </div>
          <div className="mt-4">
            <Tabs
              name="sort"
              variant="pill"
              size="sm"
              value={tab === "app" ? "new" : "trending"}
              onChange={() => undefined}
              items={[
                { id: "trending", label: "Trending" },
                { id: "new", label: "New" },
                { id: "heating", label: "Heating" },
              ]}
            />
          </div>
        </Section>

        <Section id="table" title="Table" note="Dense ledger: sticky mono header, numeric cells right-aligned in tabular mono.">
          <Card padding={0}>
            <Table
              caption="PYRE burn ledger"
              maxHeight={260}
              dense
              rows={ledger}
              rowKey={(r) => r.id}
              onRowClick={(r) => toast.info(`Open ${r.coin} burn`)}
              rowClassName={(_, i) => (i === 0 ? "text-ink" : "text-ink-2")}
              columns={[
                { key: "at", header: "Time", render: (r) => <span className="num">{timeAgo(r.at)}</span> },
                { key: "coin", header: "Coin", render: (r) => <span className="num text-ink">{r.coin}</span> },
                { key: "units", header: "Burned", numeric: true, render: (r) => <span className="text-burn">{formatTokenUnits(r.burnedUnits)}</span> },
                { key: "pct", header: "% supply", numeric: true, render: (r) => formatPct(r.pct, 3) },
                { key: "eth", header: "ETH spent", numeric: true, collapse: true, render: (r) => formatEth(r.ethWei) },
                { key: "tx", header: "Tx", collapse: true, render: (r) => <Address address={r.tx} kind="tx" chars={4} copy={false} /> },
              ]}
            />
          </Card>
          <div className="mt-4">
            <Card padding={0}>
              <Table columns={[{ key: "a", header: "Column", render: () => null }]} rows={[]} rowKey={() => ""} empty="No burns yet — the ledger has not cleared $5." />
            </Card>
          </div>
        </Section>

        <Section id="numbers" title="NumberFlow · TickFlash · ProofStrip" note="Digits roll ≤300ms. Rows flash earn/burn on change. Counters underline in accent.">
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <Label>Market cap (odometer)</Label>
              <TickFlash value={mcapMicros} className="inline-block px-1">
                <UsdFlow micros={mcapMicros} className="figure figure-xl" />
              </TickFlash>
              <div className="mt-2 text-12 text-ink-3">{formatUsdCompact(mcapMicros)} compact · changes every 1.8s</div>
            </Card>
            <Card>
              <Label>ETH burned</Label>
              <TickFlash value={ethBurnedWei} tone="burn" className="inline-block px-1">
                <EthFlow wei={ethBurnedWei} digits={3} className="figure figure-xl text-burn" />
              </TickFlash>
              <div className="mt-2 text-12 text-ink-3">{formatEth(ethBurnedWei)}</div>
            </Card>
            <Card>
              <Label>Holders</Label>
              <NumberFlow value={1_180 + tick * 3} className="figure figure-xl" />
              <div className="mt-2 text-12 text-ink-3">{formatCount(1_180 + tick * 3)} · trend follows delta</div>
            </Card>
          </div>
          <Card className="mt-4" padding="sm">
            <ProofStrip
              items={[
                { id: "burned", label: "ETH burned via Pyre", value: Number(ethBurnedWei) / 1e18, format: { minimumFractionDigits: 3, maximumFractionDigits: 3 } },
                { id: "apps", label: "apps live", value: appsLive },
                { id: "hours", label: "agent-hours today", value: agentHours },
              ]}
            />
          </Card>
        </Section>

        <Section id="heat" title="HeatGauge · GraduationRing · Sparkline" note="Heat is a value axis on the ramp. The ring seals in earn at graduation.">
          <div className="grid gap-6 md:grid-cols-3">
            <Card>
              <Label>Heat index</Label>
              <Row>
                <HeatGauge value={heat} />
                <HeatGauge value={0.12} />
                <HeatGauge value={0.95} />
              </Row>
              <div className="mt-4">
                <HeatGauge value={heat} variant="arc" />
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(heat * 100)}
                onChange={(e) => setHeat(Number(e.target.value) / 100)}
                className="mt-4 w-full accent-(--color-accent)"
                aria-label="Heat"
              />
            </Card>
            <Card>
              <Label>Graduation ring</Label>
              <Row>
                {[0.08, 0.42, 0.87].map((p) => (
                  <GraduationRing key={p} progress={p} size={56}>
                    <Avatar name="$SPLIT" size={46} />
                  </GraduationRing>
                ))}
                <GraduationRing progress={1} graduated size={56}>
                  <Avatar name="Forgewatch" size={46} />
                </GraduationRing>
              </Row>
              <div className="mt-4 text-12 text-ink-3">8% · 42% · 87% · graduated (4.2 ETH)</div>
            </Card>
            <Card>
              <Label>Sparkline</Label>
              <Row>
                <Sparkline data={SERIES_UP} />
                <Sparkline data={SERIES_DOWN} />
                <Sparkline data={SERIES_UP} tone="accent" width={120} height={36} dot />
                <Sparkline data={SERIES_DOWN} tone="plain" area={false} />
                <Sparkline data={[]} />
              </Row>
            </Card>
          </div>
        </Section>

        <Section id="console" title="ConsoleFrame" note="Rows colour-coded by tool. Scroll up to detach; a pill offers the way back to live.">
          <div className="grid gap-4 lg:grid-cols-2">
            <ConsoleFrame
              title="$SPLIT · build 3"
              session="s_01j8k2"
              status="live"
              rows={rows}
              toolbar={
                <>
                  <Chip tone="earn" size="sm" dot>
                    Scaffolded
                  </Chip>
                  <Chip tone="earn" size="sm" dot>
                    Tests passing
                  </Chip>
                  <Chip tone="build" size="sm" dot>
                    Deploying
                  </Chip>
                  <Chip size="sm">First fees</Chip>
                </>
              }
            />
            <div className="grid gap-4">
              <ConsoleFrame title="$FORGE · build 1" session="s_01j7aa" status="done" rows={rows.slice(0, 4)} height={120} />
              <ConsoleFrame title="$LEDGR" status="idle" rows={[]} height={120} />
            </div>
          </div>
        </Section>

        <Section id="overlays" title="Sheet · CommandK · Toast · Ignition" note="Spring 260/26 trays; ⌘K palette; unstyled sonner; the ignition moment.">
          <Row>
            <Button variant="secondary" onClick={() => setSheet(true)}>
              Open sheet / tray
            </Button>
            <Button variant="secondary" onClick={() => setCmd(true)} iconRight={<Kbd keys={["⌘", "K"]} />}>
              Command palette
            </Button>
            <Button variant="secondary" onClick={() => toast.success("Burned 2.14M $SPLIT", { description: "0.041 ETH · tx 0x9c2e…5a6" })}>
              Toast success
            </Button>
            <Button variant="secondary" onClick={() => toast.error("Swap reverted", { description: "InsufficientOutput · try a wider slippage" })}>
              Toast error
            </Button>
            <Button variant="secondary" onClick={() => toast.info("Sweeping fees", { description: "curve.sweepFees(0) from the app wallet" })}>
              Toast info
            </Button>
            <Button variant="secondary" onClick={() => toast.warning("Launch gated", { description: "canLaunch(appWallet) = false" })}>
              Toast warning
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                const id = toast.loading("Confirming…");
                setTimeout(() => toast.success("Confirmed in 3 blocks", { id }), 1400);
              }}
            >
              Toast loading
            </Button>
            <Button onClick={() => setIgnition(true)}>Ignition</Button>
          </Row>
          <Sheet
            open={sheet}
            onClose={() => setSheet(false)}
            eyebrow="Step 2 / 3"
            title="Story & app brief"
            footer={
              <>
                <Button variant="ghost" onClick={() => setSheet(false)}>
                  Back
                </Button>
                <Button onClick={() => setSheet(false)}>Continue</Button>
              </>
            }
          >
            <div className="space-y-4">
              <Field label="Name" htmlFor="sheet-name" required>
                <Input id="sheet-name" placeholder="Splitwise" />
              </Field>
              <Field label="Brief" htmlFor="sheet-brief" hint="What should the agent build? One paragraph.">
                <Textarea id="sheet-brief" placeholder="A receipt-splitting app…" />
              </Field>
              <p className="small text-ink-3">Drag down to dismiss on mobile. Tab is trapped; Esc closes.</p>
            </div>
          </Sheet>
          <CommandK open={cmd} onClose={() => setCmd(false)} items={commandItems} />
          <Ignition
            open={ignition}
            ticker="SPLIT"
            name="Splitwise"
            txHash={TX}
            explorerUrl={`https://robinhoodchain.blockscout.com/tx/${TX}`}
            ticks={ticks}
            status={ticks.length >= 16 ? "confirmed" : "pending"}
            action={
              <Button onClick={() => setIgnition(false)} disabled={ticks.length < 16}>
                Open coin page
              </Button>
            }
            onClose={() => setIgnition(false)}
          />
        </Section>

        <Section id="forms" title="Field · Input · Textarea · Select" note="Native controls in house chrome; errors announce via role=alert.">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Amount" htmlFor="f-amount" meta="balance 0.4821 ETH" hint="Minimum 0.001 ETH.">
              <Input id="f-amount" mono inputMode="decimal" placeholder="0.00" suffix="ETH" />
            </Field>
            <Field label="Min holding" htmlFor="f-hold" hint="Whole tokens">
              <Input id="f-hold" mono defaultValue="1000" />
            </Field>
            <Field label="Ticker" htmlFor="f-ticker" error="Ticker is taken." required>
              <Input id="f-ticker" invalid defaultValue="SPLIT" />
            </Field>
            <Field label="Template" htmlFor="f-model">
              <Select id="f-model" defaultValue="web-tool">
                <option value="web-tool">Web tool</option>
                <option value="game">Game</option>
                <option value="agent-api">Agent API</option>
              </Select>
            </Field>
            <Field label="Disabled" htmlFor="f-dis">
              <Input id="f-dis" disabled placeholder="Not now" />
            </Field>
            <Field label="Brief" htmlFor="f-brief" className="md:col-span-2">
              <Textarea id="f-brief" placeholder="What should the agent build?" />
            </Field>
          </div>
        </Section>

        <Section id="misc" title="Address · Avatar · StatusLed · Kbd · Tooltip · Progress" note="Small parts that appear everywhere.">
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <Label>Address</Label>
              <div className="space-y-2">
                <Address address={TREASURY} />
                <Address address={TREASURY} label="treasury" chars={6} />
                <Address address={TX} kind="tx" />
                <Address address={TREASURY} identicon={false} copy={false} explorerUrl={null} />
              </div>
            </Card>
            <Card>
              <Label>Avatar</Label>
              <Row>
                <Avatar name="$SPLIT" size={24} />
                <Avatar name="Forgewatch" size={32} />
                <Avatar name="Ledgr" size={40} />
                <Avatar name="receipt bot" size={48} shape="square" />
                <Avatar name="$BROKEN" src="https://pyre.fun/does-not-exist.png" size={40} />
                <Avatar name="Pyre" src="/apple-touch-icon.png" size={40} />
              </Row>
            </Card>
            <Card>
              <Label>StatusLed</Label>
              <Row>
                {ledTones.map((t) => (
                  <StatusLed key={t} tone={t} label={t} />
                ))}
              </Row>
              <Label>
                <span className="mt-4 block">Kbd</span>
              </Label>
              <Row>
                <Kbd keys={["⌘", "K"]} />
                <Kbd>esc</Kbd>
                <Kbd keys={["↑", "↓"]} />
                <Kbd>↵</Kbd>
              </Row>
            </Card>
            <Card>
              <Label>Tooltip</Label>
              <Row>
                <Tooltip content="Market cap at the last fill.">
                  <Button variant="secondary" size="sm">
                    Hover (top)
                  </Button>
                </Tooltip>
                <Tooltip content="Creator gets 70% of the 1% base fee." side="bottom">
                  <Button variant="ghost" size="sm">
                    Focus me (bottom)
                  </Button>
                </Tooltip>
              </Row>
              <Label>
                <span className="mt-4 block">Progress</span>
              </Label>
              <div className="space-y-3">
                <Progress value={0.32} label="Build budget" />
                <Progress value={0.72} tone="earn" size="md" />
                <Progress value={0.12} tone="burn" size="xs" />
                <Progress value={0.5} tone="heat" size="md" />
                <Progress value={0} indeterminate tone="build" label="Sweeping" />
              </div>
            </Card>
          </div>
        </Section>

        <Section id="empty" title="Skeleton · EmptyState" note="Skeletons breathe, never shimmer. Ash is dormant; relight is the CTA.">
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <Skeleton className="mb-3 h-5 w-32" />
              <Skeleton lines={3} />
              <div className="mt-4 flex gap-2">
                <Skeleton className="h-9 w-9" rounded="pill" />
                <Skeleton className="h-9 flex-1" rounded="card" />
              </div>
            </Card>
            <EmptyState title="No burns yet" body="The PYRE_TOKEN ledger has not cleared $5. Burns appear here as the treasury executes them." action={<Button size="sm">Open $PYRE</Button>} />
            <EmptyState
              variant="ash"
              title="$LEDGR is ash"
              body="No fees in 30 days. The agent is paused until the creator relights it."
              onRelight={() => toast.success("Relit $LEDGR", { description: "Agent funded for one more iteration." })}
            />
          </div>
        </Section>
      </main>
    </div>
  );
};

const FilterChips = () => {
  const [sel, setSel] = useState("trending");
  return (
    <>
      {["trending", "new", "heating", "graduated", "shipping"].map((f) => (
        <Chip key={f} selected={sel === f} onClick={() => setSel(f)}>
          {f}
        </Chip>
      ))}
    </>
  );
};
