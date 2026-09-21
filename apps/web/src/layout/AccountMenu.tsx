import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth.js";
import { formatEth, formatUsd, shortAddress } from "../lib/format.js";
import { Avatar, Button, cx } from "../ui/index.js";
import { IconChevronDown } from "../components/icons.js";

/**
 * Signed out: one "Sign in" button. Signed in: avatar + name opening a menu
 * with balances, the account page, ops for admins and sign out. Menu is a
 * `menu` role with arrow-key roving and Escape/outside-click dismissal.
 */
export const AccountMenu = () => {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
      if (items.length === 0) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next].focus();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!auth.ready) return <span className="h-8 w-20 rounded-pill bg-fill" aria-hidden />;
  if (!auth.authenticated || !auth.user) {
    return (
      <Button variant="secondary" size="sm" onClick={auth.signIn}>
        Sign in
      </Button>
    );
  }

  const { user, balances, notifications, wallet } = auth.user;
  const name = user.displayName ?? shortAddress(auth.externalWallet?.address ?? wallet);
  const item = "flex w-full items-center justify-between gap-3 rounded-control px-2.5 py-2 text-13 text-ink-2 outline-none hover:bg-fill hover:text-ink focus-visible:bg-fill focus-visible:text-ink";

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-9 items-center gap-2 rounded-pill border border-line-2 bg-fill pl-1 pr-2.5 text-13 font-medium text-ink transition-colors duration-(--duration-ui) hover:border-line-3 hover:bg-fill-2"
      >
        <span className="relative">
          <Avatar src={user.avatarUrl} name={name} size={26} />
          {notifications.unread > 0 && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-pill bg-accent ring-2 ring-canvas" aria-hidden />}
        </span>
        <span className="hidden max-w-[10rem] truncate sm:inline">{name}</span>
        <IconChevronDown size={12} className={cx("text-ink-3 transition-transform duration-(--duration-ui)", open && "rotate-180")} />
      </button>
      {open && (
        <div
          ref={list}
          role="menu"
          aria-label="Account"
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-64 rounded-card border border-line-2 bg-raised p-1.5 animate-rise light:shadow-paper"
        >
          <div className="px-2.5 pb-2 pt-1.5">
            <div className="eyebrow">balances</div>
            <div className="num mt-1 flex items-baseline justify-between text-13 text-ink">
              <span>{formatEth(balances.ethWei)}</span>
              <span className="text-ink-3">{formatUsd(BigInt(balances.usdgUnits))} USDG</span>
            </div>
            <div className="num mt-1 text-12 text-ink-3" title={wallet}>
              {shortAddress(wallet, 6)}
            </div>
          </div>
          <div className="my-1 h-px bg-line" />
          <Link role="menuitem" to="/me" className={item} onClick={() => setOpen(false)}>
            account
            {notifications.unread > 0 && <span className="num rounded-pill bg-accent-wash px-1.5 text-12 text-accent">{notifications.unread}</span>}
          </Link>
          <Link role="menuitem" to="/me?tab=positions" className={item} onClick={() => setOpen(false)}>
            positions
          </Link>
          <Link role="menuitem" to="/me?tab=launched" className={item} onClick={() => setOpen(false)}>
            your coins
          </Link>
          {user.isAdmin && (
            <Link role="menuitem" to="/ops" className={item} onClick={() => setOpen(false)}>
              ops
            </Link>
          )}
          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              void auth.signOut();
            }}
          >
            sign out
          </button>
        </div>
      )}
    </div>
  );
};
