import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./useAuth.js";

/**
 * Resets auth-scoped queries whenever the login state settles or changes, so a
 * fresh session never shows a previous user's cached data. The bearer token is
 * attached synchronously in `api/client`, so there is nothing to wire here.
 */
export const AuthBridge = () => {
  const { authenticated, ready } = useAuth();
  const qc = useQueryClient();

  useEffect(() => {
    if (!ready) return;
    for (const key of ["me", "app", "launch", "proposals", "admin", "pyre"]) void qc.invalidateQueries({ queryKey: [key] });
  }, [authenticated, ready, qc]);

  return null;
};
