/**
 * Web-local API shapes. Every DTO the API renders lives in `@pyre/shared`
 * (`packages/shared/src/dto.ts`); this file only holds envelopes and frames
 * that are not data the API owns.
 */
import type { BuildEventDto, Chain, Launchpad } from "@pyre/shared";

export interface ApiError {
  status: number;
  error: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface AuthResponse {
  token: string;
}

export interface WalletChallenge {
  message: string;
  nonce: string;
}

/** `GET /v1/status` — service probes for the status page. */
export interface StatusDto {
  ok: boolean;
  version: string;
  uptimeSec: number;
  services: {
    db: { ok: boolean; latencyMs: number };
    redis: { ok: boolean; latencyMs: number };
    rpc: { ok: boolean; latencyMs: number; blockNumber: number };
    queues: { ok: boolean; depths: Record<string, { waiting: number; active: number; failed: number }> };
  };
  chain: { chainId: number; ethPriceUsd: number };
  updatedAt: string;
}

/** One frame on `/v1/apps/stream`: a ranking-affecting change, with the feed event when there is one. */
export interface GlobalFrame {
  appId: string;
  slug: string;
  ticker: string;
  name: string;
  /** The app's venue, so chain amounts in `event` format in the right native asset. */
  chain: Chain;
  launchpad: Launchpad;
  type?: string;
  event?: BuildEventDto;
}
