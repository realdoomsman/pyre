import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotificationDto, WithdrawResultDto } from "@pyre/shared";
import { api } from "../../api/client.js";
import { keys } from "../../api/queries.js";

export interface WithdrawInput {
  asset: "ETH" | "USDG";
  to: string;
  amount: number;
}

export const useWithdraw = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WithdrawInput) => api.post<WithdrawResultDto>("/v1/me/withdraw", body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.me }),
  });
};

export interface ClaimResult {
  usdMicros: string;
  wei: string;
  txHash: string;
}

/** Launcher fee share, paid in ETH from the treasury to the custodial wallet. */
export const useClaimLauncher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ClaimResult>("/v1/me/claim", {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.me }),
  });
};

/** Relight / top up an app's build budget from the custodial ETH balance. */
export const useTopup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, eth }: { slug: string; eth: number }) => api.post<{ ok: true }>(`/v1/apps/${slug}/topup`, { eth }),
    onSuccess: (_r, { slug }) => {
      void qc.invalidateQueries({ queryKey: keys.me });
      void qc.invalidateQueries({ queryKey: keys.app(slug) });
    },
  });
};

export interface NotificationsPage {
  items: NotificationDto[];
  unread: number;
}

export const notificationsKey = ["me", "notifications"] as const;

export const useNotifications = (enabled: boolean) =>
  useQuery({
    queryKey: notificationsKey,
    queryFn: ({ signal }) => api.get<NotificationsPage>("/v1/me/notifications", signal),
    enabled,
    refetchInterval: 60_000,
  });

export const useMarkRead = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) => api.post<{ ok: true }>("/v1/me/notifications/read", ids ? { ids } : {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: notificationsKey });
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
};
