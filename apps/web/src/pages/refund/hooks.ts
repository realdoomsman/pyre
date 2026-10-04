import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RefundChallengeDto, RefundHolderDto, RefundSummaryDto } from "@pyre/shared";
import { api, isHttpError } from "../../api/client.js";

export const refundKey = ["refund"] as const;
const holderKey = (address: string) => [...refundKey, "holder", address.toLowerCase()] as const;

/** A 4xx is an answer (bad address, not on the snapshot), not a blip worth retrying. */
const retryServerErrors = (count: number, e: Error) => !(isHttpError(e) && e.status >= 400 && e.status < 500) && count < 2;

export const useRefundSummary = () =>
  useQuery({
    queryKey: refundKey,
    queryFn: ({ signal }) => api.get<RefundSummaryDto>("/v1/refund", signal),
    refetchInterval: 60_000,
    retry: retryServerErrors,
  });

/** `GET /v1/refund/holders/:address`; idle while `address` is null. */
export const useRefundHolder = (address: string | null) =>
  useQuery({
    queryKey: holderKey(address ?? ""),
    queryFn: ({ signal }) => api.get<RefundHolderDto>(`/v1/refund/holders/${encodeURIComponent(address ?? "")}`, signal),
    enabled: address !== null,
    retry: retryServerErrors,
    refetchInterval: 60_000,
  });

export interface LinkInput {
  address: string;
  solWallet: string;
  nonce: string;
  solSignature: string;
  evmSignature?: string;
}

export const requestLinkChallenge = (body: { address: string; solWallet: string }) => api.post<RefundChallengeDto>("/v1/refund/link/challenge", body);

export const useLinkRefund = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LinkInput) => api.post<RefundHolderDto>("/v1/refund/link", body),
    onSuccess: (holder) => {
      qc.setQueryData(holderKey(holder.address), holder);
      void qc.invalidateQueries({ queryKey: refundKey, exact: true });
    },
  });
};
