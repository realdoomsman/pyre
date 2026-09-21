import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, type PanInfo } from "motion/react";
import { duration, ease, spring, useReducedMotion } from "../lib/motion.js";
import { Button } from "./Button.js";
import { cx } from "./cx.js";
import { useFocusTrap } from "./useFocusTrap.js";
import { useIsMobile } from "./useMediaQuery.js";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Mono eyebrow above the title (step "2 / 3", a ticker). */
  eyebrow?: ReactNode;
  /** `auto`: bottom tray on mobile, right-hand sheet on desktop. */
  side?: "auto" | "bottom" | "right";
  /** Desktop sheet width. */
  width?: number;
  /** Sticky footer slot (actions). */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

const IconClose = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
    <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/**
 * Sheet on desktop, Tray on mobile. Springs 260/26; the tray is draggable and
 * dismisses on a fast or far downward fling (velocity-aware, Family-style).
 */
export const Sheet = ({ open, onClose, title, eyebrow, side = "auto", width = 440, footer, children, className }: SheetProps) => {
  const mobile = useIsMobile();
  const reduced = useReducedMotion();
  const panel = useRef<HTMLDivElement>(null);
  const resolved = side === "auto" ? (mobile ? "bottom" : "right") : side;
  const tray = resolved === "bottom";
  useFocusTrap(panel, open, onClose);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.velocity.y > 600 || info.offset.y > 140) onClose();
  };

  const transition = reduced ? { duration: duration.ui, ease: ease.ui } : spring.tray;
  const hidden = tray ? { y: "100%" } : { x: "100%" };

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50" role="presentation">
          <motion.div
            className="absolute inset-0 bg-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: duration.ui, ease: ease.ui }}
            onClick={onClose}
          />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label={typeof title === "string" ? title : undefined}
            tabIndex={-1}
            initial={hidden}
            animate={tray ? { y: 0 } : { x: 0 }}
            exit={hidden}
            transition={transition}
            drag={tray && !reduced ? "y" : false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={onDragEnd}
            className={cx(
              "absolute flex flex-col bg-surface outline-none",
              tray
                ? "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-[20px] border-t border-line pb-[env(safe-area-inset-bottom)]"
                : "inset-y-0 right-0 border-l border-line",
              className,
            )}
            style={tray ? undefined : { width: `min(${width}px, 100vw)` }}
          >
            {tray && (
              <div className="flex justify-center pt-2.5" aria-hidden>
                <span className="h-1 w-9 rounded-pill bg-line-3" />
              </div>
            )}
            {(title || eyebrow) && (
              <header className="flex items-start justify-between gap-4 px-5 pb-3 pt-4">
                <div className="min-w-0">
                  {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
                  {title && <h2 className="h3 truncate">{title}</h2>}
                </div>
                <Button variant="icon" size="sm" label="Close" onClick={onClose} className="-mr-1.5 -mt-1">
                  <IconClose />
                </Button>
              </header>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
            {footer && <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
};

/** Alias for readers who reach for the mobile name. */
export const Tray = Sheet;
