import { renderRegisteredNode, type ComponentRenderContext } from "@/components/registry/component-registry";
import type { AppNode } from "@/core/models";

export function AppSpecRenderer({ node, context }: { node: AppNode; context: ComponentRenderContext }) {
  const children = node.children?.map((child) => <AppSpecRenderer key={child.id} node={child} context={context} />);
  return renderRegisteredNode(node, children, context);
}
