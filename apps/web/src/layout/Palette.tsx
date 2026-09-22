import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppSearch } from "../api/queries.js";
import { formatUsdCompact } from "../lib/format.js";
import { EVM_ADDRESS, SOLANA_ADDRESS } from "../lib/venue.js";
import { Avatar, CommandK, Kbd, type CommandItem } from "../ui/index.js";
import { IconApps, IconBurn, IconLaunch, IconPyre, IconUser } from "../components/icons.js";

/**
 * ⌘K. Searches coins by name, ticker, slug or token address through
 * `/v1/apps?q=`, and offers the four destinations. Pasting a full address —
 * 0x on Robinhood Chain or base58 on Solana — resolves straight to the coin
 * when the API knows it.
 */
export const Palette = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const q = query.trim();
  const search = useAppSearch(q);

  const items = useMemo<CommandItem[]>(() => {
    const go = (to: string) => () => void navigate(to);
    const coins: CommandItem[] = (search.data ?? []).map((a) => ({
      id: `coin:${a.slug}`,
      group: "coins",
      label: `$${a.ticker} · ${a.name}`,
      hint: formatUsdCompact(Math.round(a.mcapUsd * 1e6)),
      icon: <Avatar src={a.imageUrl} name={a.ticker} size={20} />,
      keywords: [a.slug, a.ticker, a.name, a.tokenAddress ?? "", a.chain, a.launchpad.replace("_", " ")],
      onSelect: go(`/c/${a.slug}`),
    }));
    const actions: CommandItem[] = [
      { id: "go:launch", group: "go to", label: "Launch a coin", hint: "/launch", icon: <IconLaunch />, keywords: ["launch", "new", "create"], onSelect: go("/launch") },
      { id: "go:apps", group: "go to", label: "App store", hint: "/apps", icon: <IconApps />, keywords: ["apps", "store"], onSelect: go("/apps") },
      { id: "go:burns", group: "go to", label: "PYRE burns", hint: "/burns", icon: <IconBurn />, keywords: ["burns", "ledger", "pyre"], onSelect: go("/burns") },
      { id: "go:pyre", group: "go to", label: "$PYRE", hint: "/pyre", icon: <IconPyre />, keywords: ["pyre", "token"], onSelect: go("/pyre") },
      { id: "go:me", group: "go to", label: "Your account", hint: "/me", icon: <IconUser />, keywords: ["me", "account", "wallet", "balances"], onSelect: go("/me") },
    ];
    // With a query, coin results lead; the palette's own substring filter
    // still applies to the actions so "burn" surfaces the ledger.
    return q ? [...coins, ...actions] : actions;
  }, [search.data, navigate, q]);

  const onQueryChange = useCallback((next: string) => setQuery(next), []);

  const address = EVM_ADDRESS.test(q) || SOLANA_ADDRESS.test(q);
  const empty = address
    ? search.isFetching
      ? "resolving address…"
      : "no pyre coin at that address"
    : search.isFetching
      ? "searching…"
      : q
        ? "no coin matches"
        : "type a name, ticker, 0x or base58 address";

  return (
    <CommandK
      open={open}
      onClose={onClose}
      items={items}
      onQueryChange={onQueryChange}
      placeholder="Search coins, tickers, addresses…"
      empty={empty}
      footer={
        <>
          <span className="inline-flex items-center gap-1.5">
            <Kbd keys={["↑", "↓"]} /> navigate
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>↵</Kbd> open
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5">paste a token address (0x or base58) to jump to its coin</span>
        </>
      }
    />
  );
};

