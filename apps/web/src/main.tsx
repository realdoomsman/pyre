import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { router } from "./router.js";
import { AuthProvider } from "./auth/AuthProvider.js";
import { AuthBridge } from "./auth/AuthBridge.js";
import { isHttpError } from "./api/client.js";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(isHttpError(err) && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

/*
 * `AuthProvider` is wallet-free at the entry: the sign-in sheet (Google
 * Identity Services + viem for the wallet challenge) is loaded on demand only
 * when a visitor signs in, so the home page and the share cards boot without it.
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AuthBridge />
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
