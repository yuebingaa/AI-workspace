"use client";

import { useEffect, useState, type RefObject } from "react";
import { createStudioSnapshot, type StudioRepository } from "@/core/repository";
import type { PersistWorkspace, WorkspaceSnapshot } from "./contracts";
import { StudioPersistenceController } from "./persistence-controller";

type StudioPersistenceContext = Pick<WorkspaceSnapshot,
  "dataProduct" | "execution" | "auditRecords" | "queryRecords" | "harnessTasks" | "edsWorkspace" | "assistantConversation" | "assistantSessions"
> & {
  isHistoryLoading: boolean;
  projectRepository: StudioRepository | null;
  repositoryRef: RefObject<StudioRepository | null>;
  setPersistenceNotice(notice: string | null): void;
};

/** React lifecycle adapter; hydration and repository selection remain with the workspace. */
export function useStudioPersistence({
  dataProduct, execution, auditRecords, queryRecords, harnessTasks, edsWorkspace, assistantConversation, assistantSessions,
  isHistoryLoading, projectRepository, repositoryRef, setPersistenceNotice,
}: StudioPersistenceContext) {
  const [controller] = useState(() => new StudioPersistenceController());

  useEffect(() => {
    if (isHistoryLoading) return;
    return controller.scheduleAutomatic({
      repository: projectRepository ?? repositoryRef.current,
      mode: projectRepository ? "project" : "temporary",
      queryRecords,
      conversationState: assistantSessions,
      snapshot: () => createStudioSnapshot(dataProduct, execution, auditRecords, queryRecords, harnessTasks, edsWorkspace, assistantConversation, assistantSessions),
    }, setPersistenceNotice);
  }, [controller, isHistoryLoading, projectRepository, repositoryRef, dataProduct, execution, auditRecords,
    queryRecords, harnessTasks, edsWorkspace, assistantConversation, assistantSessions, setPersistenceNotice]);

  // Explicit user actions stay synchronous and return the original StudioSaveResult.
  // For project repositories, this acknowledges queuing, not a completed disk flush.
  const persistExplicitly: PersistWorkspace = (
    nextExecution = execution, nextAuditRecords = auditRecords, nextQueryRecords = queryRecords,
    nextDataProduct = dataProduct, nextHarnessTasks = harnessTasks, nextEdsWorkspace = edsWorkspace,
    nextAssistantConversation = assistantConversation,
    nextAssistantSessions = assistantSessions,
  ) => {
    const result = controller.saveExplicitly(repositoryRef.current,
      createStudioSnapshot(nextDataProduct, nextExecution, nextAuditRecords, nextQueryRecords, nextHarnessTasks, nextEdsWorkspace, nextAssistantConversation, nextAssistantSessions));
    if (!result.persisted) setPersistenceNotice(result.notice);
    return result;
  };

  return {
    persistExplicitly,
    markQueriesRestored: (records: WorkspaceSnapshot["queryRecords"]) => controller.markQueriesRestored(repositoryRef.current, records),
  };
}
