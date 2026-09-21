import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProposalDto, UserRefDto } from "@pyre/shared";
import { api } from "../../api/client.js";

export interface ProposalsPage {
  items: ProposalDto[];
  pyreLaunched: boolean;
  /** $PYRE base units (1e18) a wallet must hold to submit. */
  minHoldUnits: string;
  /** $PYRE base units of capped vote weight a proposal needs to be "backed". */
  quorumUnits: string;
}

export interface ProposalCommentDto {
  id: string;
  author: UserRefDto;
  body: string;
  createdAt: string;
}

export const proposalsKey = ["proposals"] as const;
export const commentsKey = (id: string) => ["proposals", id, "comments"] as const;

export const useProposals = () =>
  useQuery({ queryKey: proposalsKey, queryFn: ({ signal }) => api.get<ProposalsPage>("/v1/proposals", signal), refetchInterval: 60_000 });

const useInvalidate = () => {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: proposalsKey });
};

export const useSubmitProposal = () => {
  const done = useInvalidate();
  return useMutation({ mutationFn: (body: { title: string; body: string }) => api.post<ProposalDto>("/v1/proposals", body), onSuccess: done });
};

export const useVote = () => {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => (on ? api.post<unknown>(`/v1/proposals/${id}/vote`, {}) : api.del<unknown>(`/v1/proposals/${id}/vote`)),
    onSuccess: done,
  });
};

export const useSetStatus = () => {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: ProposalDto["status"]; note?: string }) => api.post<ProposalDto>(`/v1/proposals/${id}/status`, { status, note }),
    onSuccess: done,
  });
};

export const useComments = (id: string, enabled: boolean) =>
  useQuery({ queryKey: commentsKey(id), queryFn: ({ signal }) => api.get<{ items: ProposalCommentDto[] }>(`/v1/proposals/${id}/comments`, signal), enabled });

export const useAddComment = (id: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api.post<ProposalCommentDto>(`/v1/proposals/${id}/comments`, { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: commentsKey(id) });
      void qc.invalidateQueries({ queryKey: proposalsKey });
    },
  });
};
