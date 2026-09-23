import type { AppNode } from "@/core/models";

export function compactNodes(node: AppNode): Array<{ id: string; type: AppNode["type"]; childCount: number }> {
  return [
    { id: node.id, type: node.type, childCount: node.children?.length ?? 0 },
    ...(node.children?.flatMap(compactNodes) ?? []),
  ];
}

export function findAppNode(node: AppNode, nodeId: string): AppNode | undefined {
  if (node.id === nodeId) return node;
  for (const child of node.children ?? []) {
    const match = findAppNode(child, nodeId);
    if (match) return match;
  }
  return undefined;
}

export const EDS_TABLE_FIELDS = ["view", "line", "category", "occurrences", "minutes"] as const;
