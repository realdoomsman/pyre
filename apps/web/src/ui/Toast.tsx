import { Toaster as SonnerToaster, toast } from "sonner";
import { useIsMobile } from "./useMediaQuery.js";

export { toast };

const IconOk = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
    <path d="M3 7.5 5.8 10 11 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IconErr = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
    <path d="M4 4l6 6M10 4l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
const IconInfo = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
    <circle cx="7" cy="7" r="5.5" stroke="currentColor" />
    <path d="M7 6.2v3.6M7 4.2v.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);
const IconWarn = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
    <path d="M7 2 12.5 11.5h-11L7 2Z" stroke="currentColor" strokeLinejoin="round" />
    <path d="M7 6v2.6M7 10.4v.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);
const IconLoad = () => (
  <svg className="animate-spin" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
    <circle cx="7" cy="7" r="5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.6" />
    <path d="M12 7a5 5 0 0 0-5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

/**
 * Sonner, unstyled and dressed in the house tokens. Mount once at the app root.
 * Bottom-centre on phones (above the tab bar), bottom-right on desktop.
 */
export const Toaster = () => {
  const mobile = useIsMobile();
  return (
    <SonnerToaster
      position={mobile ? "bottom-center" : "bottom-right"}
      offset={mobile ? 72 : 20}
      gap={8}
      visibleToasts={4}
      closeButton={false}
      icons={{ success: <IconOk />, error: <IconErr />, info: <IconInfo />, warning: <IconWarn />, loading: <IconLoad /> }}
      toastOptions={{
        unstyled: true,
        duration: 4200,
        classNames: {
          toast:
            "flex w-[356px] max-w-[calc(100vw-32px)] items-start gap-3 rounded-card border border-line-2 bg-raised px-4 py-3 text-14 text-ink light:shadow-paper",
          title: "font-medium leading-5",
          description: "small text-ink-2",
          icon: "mt-0.5 grid h-5 w-5 shrink-0 place-items-center",
          success: "[&_[data-icon]]:text-earn",
          error: "[&_[data-icon]]:text-danger",
          warning: "[&_[data-icon]]:text-warn",
          info: "[&_[data-icon]]:text-build",
          loading: "[&_[data-icon]]:text-ink-2",
          actionButton: "ml-auto h-7 shrink-0 rounded-pill bg-accent px-3 text-12 font-medium text-accent-ink",
          cancelButton: "ml-auto h-7 shrink-0 rounded-pill bg-fill px-3 text-12 font-medium text-ink-2",
        },
      }}
    />
  );
};
