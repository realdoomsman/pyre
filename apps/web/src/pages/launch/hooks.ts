import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppSpec, CreateLaunchBody, LaunchDraftDto, StakeBody } from "@pyre/shared";
import { api } from "../../api/client.js";
import { keys } from "../../api/queries.js";

interface LaunchEnvelope {
  launch: LaunchDraftDto;
}

export const launchKey = (id: string | null) => ["launch", id] as const;

/** Statuses the server is still working through — keep polling while in one of these. */
const POLLING: Partial<Record<LaunchDraftDto["status"], true>> = { DRAFT: true, LAUNCHING: true, AWAITING_STAKE: true, LAUNCH_GATED: true };

/**
 * The draft being launched. Polls every 2 s while the intake agent drafts the spec or the
 * launch worker is on-chain; stops once the draft is terminal or waiting on the user.
 */
export const useLaunchDraft = (id: string | null) =>
  useQuery({
    queryKey: launchKey(id),
    queryFn: ({ signal }) => api.get<LaunchEnvelope>(`/v1/launches/${id}`, signal).then((r) => r.launch),
    enabled: id !== null,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return status && POLLING[status] ? 2000 : false;
    },
  });

export const useCreateLaunch = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLaunchBody) => api.post<LaunchEnvelope>("/v1/launches", body).then((r) => r.launch),
    onSuccess: (launch) => qc.setQueryData(launchKey(launch.id), launch),
  });
};

export const useForkLaunch = (slug: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<CreateLaunchBody, "prompt"> & { prompt?: string }) =>
      api.post<LaunchEnvelope>(`/v1/apps/${slug}/fork`, body).then((r) => r.launch),
    onSuccess: (launch) => qc.setQueryData(launchKey(launch.id), launch),
  });
};

export interface ApproveResult {
  launch: LaunchDraftDto;
  stake: { to: string; wei: string };
}

export const useApproveSpec = (id: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spec: AppSpec) => api.post<ApproveResult>(`/v1/launches/${id}/approve`, { spec }),
    onSuccess: (r) => qc.setQueryData(launchKey(id), r.launch),
  });
};

export const useStake = (id: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StakeBody) => api.post<LaunchEnvelope>(`/v1/launches/${id}/stake`, body).then((r) => r.launch),
    onSuccess: (launch) => {
      qc.setQueryData(launchKey(id), launch);
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
};

interface Receipt {
  blockNumber: string;
  status: "0x0" | "0x1";
}

/**
 * Confirmation of the launch transaction, read through the platform's JSON-RPC proxy. Polls at
 * 1 s until the receipt exists; the block number becomes an Ignition tick.
 */
export const useTxReceipt = (hash: string | null) =>
  useQuery({
    queryKey: ["receipt", hash],
    queryFn: async ({ signal }) => {
      const r = await api.post<{ result: Receipt | null }>("/v1/rpc", { jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] });
      void signal;
      return r.result;
    },
    enabled: hash !== null,
    refetchInterval: (q) => (q.state.data ? false : 1000),
  });
