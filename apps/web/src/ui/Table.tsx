import type { ReactNode } from "react";
import { cx } from "./cx.js";

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Numeric columns: right-aligned tabular mono. */
  numeric?: boolean;
  width?: number | string;
  /** Hide below `md`. */
  collapse?: boolean;
  render: (row: T, index: number) => ReactNode;
}

export interface TableProps<T> {
  columns: ReadonlyArray<Column<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  /** Per-row extra classes (e.g. a cooling burn row). */
  rowClassName?: (row: T, index: number) => string | undefined;
  /** Scroll container height; the header stays pinned. */
  maxHeight?: number | string;
  dense?: boolean;
  empty?: ReactNode;
  caption?: string;
  className?: string;
}

/**
 * Dense ledger table: hairline rows, sticky mono header, numeric cells in
 * tabular mono so a changing digit never reflows the column.
 */
export const Table = <T,>({ columns, rows, rowKey, onRowClick, rowClassName, maxHeight, dense, empty, caption, className }: TableProps<T>) => {
  const pad = dense ? "px-3 py-1.5" : "px-3 py-2.5";
  return (
    <div className={cx("relative w-full overflow-auto", className)} style={{ maxHeight }}>
      <table className="w-full border-collapse text-13">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                style={{ width: c.width }}
                className={cx(
                  "eyebrow sticky top-0 z-10 bg-surface text-left shadow-[inset_0_-1px_0_var(--color-line)]",
                  pad,
                  c.numeric && "text-right",
                  c.collapse && "hidden md:table-cell",
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-10 text-center text-14 text-ink-3">
                {empty ?? "Nothing here yet."}
              </td>
            </tr>
          )}
          {rows.map((row, i) => (
            <tr
              key={rowKey(row, i)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
              className={cx(
                "border-b border-line transition-colors duration-(--duration-ui) ease-(--ease-ui) last:border-b-0",
                onRowClick && "cursor-pointer hover:bg-fill focus-visible:bg-fill",
                rowClassName?.(row, i),
              )}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cx(pad, "whitespace-nowrap align-middle", c.numeric && "num text-right", c.collapse && "hidden md:table-cell")}
                >
                  {c.render(row, i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
