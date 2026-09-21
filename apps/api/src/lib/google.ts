import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../env.js";

/**
 * Verifies a Google Identity Services ID token entirely on our side — no Google API call beyond
 * the cached JWKS. Checks the RS256 signature, that `aud` is our OAuth client, and that `iss` is
 * Google. This is the whole of the "self-hosted Google login": Google only mints the token.
 */
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export interface GoogleIdentity {
  sub: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}

export const verifyGoogleIdToken = async (credential: string): Promise<GoogleIdentity> => {
  const { payload } = await jwtVerify(credential, JWKS, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: env.GOOGLE_CLIENT_ID,
  });
  if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new Error("google token missing sub");
  return {
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    name: typeof payload.name === "string" ? payload.name : null,
    picture: typeof payload.picture === "string" ? payload.picture : null,
  };
};
