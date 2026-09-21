import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PyrePageDto, PyreStakeDto } from "@pyre/shared";
import { api } from "../../api/client.js";
import { keys } from "../../api/queries.js";

export const pyreKey = ["pyre"] as const;

export const usePyre = () =>
  useQuery({
    queryKey: pyreKey,
    queryFn: ({ signal }) => api.get<PyrePageDto>("/v1/pyre", signal),
    refetchInterval: 30_000,
  });

const useRefresh = () => {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: pyreKey });
    void qc.invalidateQueries({ queryKey: keys.me });
  };
};

export const useStakePyre = () => {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (body: { appId: string; amount: number }) => api.post<PyreStakeDto>("/v1/pyre/stake", body), onSuccess: refresh });
};

export const useUnstakePyre = () => {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (stakeId: string) => api.post<PyreStakeDto>("/v1/pyre/unstake", { stakeId }), onSuccess: refresh });
};

export const useClaimStaker = () => {
  const refresh = useRefresh();
  return useMutation({ mutationFn: () => api.post<{ usdMicros: string; wei: string; txHash: string }>("/v1/pyre/claim", {}), onSuccess: refresh });
};
