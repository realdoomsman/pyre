import { lazy, Suspense } from "react";
import type { ReactNode } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { Shell } from "./layout/Shell.js";
import { Skeleton } from "./ui/index.js";
import { useAuth } from "./auth/useAuth.js";

/*
 * Every route is its own chunk. The dynamic imports below are the split
 * points: a static import would put every page — the chart library, the
 * launch flow — into the entry chunk the home page waits on.
 */
const Home = lazy(async () => ({ default: (await import("./pages/home/Home.js")).Home }));
const Launch = lazy(async () => ({ default: (await import("./pages/launch/Launch.js")).Launch }));
const CoinPage = lazy(async () => ({ default: (await import("./pages/coin/CoinPage.js")).CoinPage }));
const AppStore = lazy(async () => ({ default: (await import("./pages/apps/AppStore.js")).AppStore }));
const Burns = lazy(async () => ({ default: (await import("./pages/burns/Burns.js")).Burns }));
const MePage = lazy(async () => ({ default: (await import("./pages/me/MePage.js")).MePage }));
const PyrePage = lazy(async () => ({ default: (await import("./pages/pyre/PyrePage.js")).PyrePage }));
const Governance = lazy(async () => ({ default: (await import("./pages/governance/Governance.js")).Governance }));
const OpsPage = lazy(async () => ({ default: (await import("./pages/ops/OpsPage.js")).OpsPage }));
const Status = lazy(async () => ({ default: (await import("./pages/status/Status.js")).Status }));
const LegalPage = lazy(async () => ({ default: (await import("./pages/legal/LegalPage.js")).LegalPage }));
const NotFound = lazy(async () => ({ default: (await import("./pages/NotFound.js")).NotFound }));
const ShareBoard = lazy(async () => ({ default: (await import("./pages/share/ShareBoard.js")).ShareBoard }));
const ShareCoin = lazy(async () => ({ default: (await import("./pages/share/ShareCoin.js")).ShareCoin }));
const UiGallery = lazy(async () => ({ default: (await import("./pages/ui/UiGallery.js")).UiGallery }));

type Shape = "feed" | "detail" | "list" | "form" | "short";

/**
 * The shape of a page before its chunk lands. Holding roughly the height of
 * the real page keeps the footer off-screen across the swap (the footer
 * jumping into view was measured at 0.31 CLS on a phone); pages that are
 * legitimately short must not do that, or the footer jumps the other way.
 */
const PageFallback = ({ shape }: { shape: Shape }) => (
  <div className={shape === "short" ? "space-y-4" : "min-h-svh space-y-6"} role="status" aria-live="polite" aria-label="Loading page">
    {shape === "feed" && (
      <>
        <Skeleton className="h-[220px] w-full" rounded="card" />
        <div className="flex gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-20" rounded="pill" />
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-[196px] w-full" rounded="card" />
          ))}
        </div>
      </>
    )}
    {shape === "detail" && (
      <>
        <div className="flex items-center gap-4">
          <Skeleton className="h-14 w-14" rounded="pill" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-72" />
          </div>
        </div>
        <Skeleton className="h-[360px] w-full" rounded="card" />
        <Skeleton lines={4} />
      </>
    )}
    {shape === "list" && (
      <>
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-4 w-96" />
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </>
    )}
    {shape === "form" && (
      <>
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-4 w-80" />
        <Skeleton className="h-[420px] w-full max-w-2xl" rounded="card" />
      </>
    )}
    {shape === "short" && (
      <>
        <Skeleton className="h-10 w-64" />
        <Skeleton lines={3} className="max-w-md" />
      </>
    )}
  </div>
);

/*
 * /me and /ops are short signed out and long signed in. We know which state we
 * are in synchronously — a returning session is detected from the stored token
 * before /v1/me resolves — so decide per render.
 */
const AuthSizedFallback = ({ shape }: { shape: Shape }) => {
  const auth = useAuth();
  return <PageFallback shape={!auth.ready || auth.authenticated ? shape : "short"} />;
};

const page = (node: ReactNode, shape: Shape, auth = false) => (
  <Suspense fallback={auth ? <AuthSizedFallback shape={shape} /> : <PageFallback shape={shape} />}>{node}</Suspense>
);

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    errorElement: <Shell error />,
    children: [
      { index: true, element: page(<Home />, "feed") },
      { path: "launch", element: page(<Launch />, "form") },
      { path: "c/:slug", element: page(<CoinPage />, "detail") },
      { path: "apps", element: page(<AppStore />, "feed") },
      { path: "burns", element: page(<Burns />, "list") },
      { path: "me", element: page(<MePage />, "list", true) },
      { path: "pyre", element: page(<PyrePage />, "detail") },
      { path: "governance", element: page(<Governance />, "list") },
      { path: "ops", element: page(<OpsPage />, "list", true) },
      { path: "status", element: page(<Status />, "short") },
      { path: "legal", element: <Navigate to="/legal/terms" replace /> },
      { path: "legal/:doc", element: page(<LegalPage />, "list") },
      { path: "*", element: page(<NotFound />, "short") },
    ],
  },
  // Share compositions: fixed 1200×630, outside the Shell so no chrome lands in
  // the screenshot. Rendered by a screenshot runner, so the fallback is blank
  // rather than a skeleton that could be captured mid-load.
  { path: "/card", element: <Suspense fallback={null}>{<ShareBoard />}</Suspense> },
  { path: "/c/:slug/card", element: <Suspense fallback={null}>{<ShareCoin />}</Suspense> },
  { path: "/_ui", element: <Suspense fallback={null}>{<UiGallery />}</Suspense> },
]);
