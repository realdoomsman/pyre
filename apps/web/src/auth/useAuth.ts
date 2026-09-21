import { useAuthState } from "./AuthProvider.js";
import type { AuthState, ExternalWallet } from "./AuthProvider.js";

export type { AuthState, ExternalWallet };

/**
 * Auth for the whole app: `signIn()` opens the sign-in sheet (Google or an
 * injected wallet), `wallet` is the user's custodial address, `externalWallet`
 * is the injected wallet when they signed in with one, and `authenticated`
 * reflects a valid platform session.
 */
export const useAuth = (): AuthState => useAuthState();
