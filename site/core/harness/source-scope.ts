import type { AppNode } from "@/core/models";
import type { HarnessPublicRequest } from "./contracts";

export function bindingDataSourceId(node: AppNode): string | undefined {
  const binding = "binding" in node.props ? node.props.binding : undefined;
  return binding && typeof binding === "object" && "dataSourceId" in binding && typeof binding.dataSourceId === "string"
    ? binding.dataSourceId
    : undefined;
}

function boundDataSourceIds(node: AppNode): string[] {
  const sourceId = bindingDataSourceId(node);
  return [...(sourceId ? [sourceId] : []), ...(node.children?.flatMap(boundDataSourceIds) ?? [])];
}

/** Shared request selection only: these IDs never grant data access or replace server authorization. */
export function resolveHarnessPageDataSourceIds(
  request: Pick<HarnessPublicRequest, "notebookContext" | "appSpec" | "pageId" | "dataSourceId" | "instruction">,
): string[] {
  if (request.notebookContext) return [...new Set(request.notebookContext.sourceIds)]
    .filter((id) => request.appSpec.dataSources.some((source) => source.id === id));
  const page = request.appSpec.pages.find((candidate) => candidate.id === request.pageId);
  if (!page) return [];
  const boundIds = boundDataSourceIds(page.root);
  const mentionedIds = request.appSpec.dataSources
    .filter((source) => request.instruction.includes(source.id) || request.instruction.includes(source.name))
    .map((source) => source.id);
  return [...new Set([...(request.dataSourceId ? [request.dataSourceId] : []), ...mentionedIds, ...boundIds])]
    .filter((id) => request.appSpec.dataSources.some((source) => source.id === id));
}
