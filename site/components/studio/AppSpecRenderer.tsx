import { renderRegisteredNode } from "@/components/registry/component-registry";
import type { AppNode } from "@/core/models";

export function AppSpecRenderer({ node }: { node: AppNode }) {
  const children = node.children?.map((child) => <AppSpecRenderer key={child.id} node={child} />);
  return renderRegisteredNode(node, children);
}
