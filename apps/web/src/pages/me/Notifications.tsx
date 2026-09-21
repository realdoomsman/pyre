import { useNavigate } from "react-router-dom";
import { timeAgo } from "../../lib/format.js";
import { Button, EmptyState, Skeleton, cx } from "../../ui/index.js";
import { useMarkRead, useNotifications } from "./hooks.js";

export const Notifications = () => {
  const navigate = useNavigate();
  const q = useNotifications(true);
  const mark = useMarkRead();

  if (q.isPending) return <Skeleton lines={5} />;
  if (q.isError || !q.data) return <p className="small text-danger">Notifications could not be loaded.</p>;
  const { items, unread } = q.data;

  if (items.length === 0) {
    return <EmptyState title="Nothing yet" body="Build milestones, claimable fees and proposal updates land here." />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="small text-ink-3">{unread > 0 ? `${unread} unread` : "All read"}</span>
        {unread > 0 && (
          <Button variant="ghost" size="sm" loading={mark.isPending} onClick={() => mark.mutate(undefined)}>
            Mark all read
          </Button>
        )}
      </div>
      <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
        {items.map((n) => {
          const open = () => {
            if (!n.readAt) mark.mutate([n.id]);
            if (n.href) navigate(n.href);
          };
          return (
            <li key={n.id}>
              <button type="button" onClick={open} className={cx("flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-(--duration-ui) hover:bg-fill", !n.href && !n.readAt ? "cursor-default" : "")}>
                <span className={cx("mt-2 h-1.5 w-1.5 shrink-0 rounded-pill", n.readAt ? "bg-transparent" : "bg-accent")} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className={cx("block text-14", n.readAt ? "text-ink-2" : "font-medium text-ink")}>{n.title}</span>
                  {n.body && <span className="small block text-ink-3">{n.body}</span>}
                </span>
                <span className="num shrink-0 text-12 text-ink-3">{timeAgo(n.createdAt)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
