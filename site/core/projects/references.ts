import type { StudioPersistedState } from "@/core/repository/studio-repository";
import type { AppNode, AppSpec, DataRecipe } from "@/core/models";

/** Registry membership alone is not a live use. Check actual analysis/model/binding references. */
export function projectDatasetReferences(state: StudioPersistedState | null, datasetId: string, importedPreviewRecipe?: DataRecipe, preview?: AppSpec): string[] {
  if (!state) return [];
  const uses: string[] = [];
  function visit(node: AppNode, page: string) {
    if ("binding" in node.props && node.props.binding.dataSourceId === datasetId) uses.push(`看板：${page} / ${node.type}`);
    node.children?.forEach((child) => visit(child, page));
  }
  state.appSpec.pages.forEach((page) => visit(page.root, page.title));
  preview?.pages.forEach((page) => visit(page.root, `待确认预览 / ${page.title}`));
  state.changeHistory.forEach((entry) => entry.appSpec.pages.forEach((page) => visit(page.root, `可撤销历史 / ${page.title}`)));
  Object.values(state.dataProduct.notebooks ?? {}).forEach((book) => {
    if (book.cells.some((cell) => cell.kind === "data" && cell.sourceDataSourceId === datasetId)) uses.push(`Notebook：${book.name}`);
  });
  state.dataProduct.semanticLayer?.models.forEach((model) => { if (model.sourceDatasetId === datasetId) uses.push(`语义模型：${model.name}`); });
  state.dataProduct.recipes.forEach((recipe) => {
    const isOriginalPreview = importedPreviewRecipe && recipe.id === importedPreviewRecipe.id
      && recipe.outputDatasetId === importedPreviewRecipe.outputDatasetId
      && JSON.stringify(recipe.steps) === JSON.stringify(importedPreviewRecipe.steps);
    if (recipe.sourceDatasetId === datasetId && !isOriginalPreview) uses.push(`配方：${recipe.name}`);
  });
  return [...new Set(uses)].slice(0, 30);
}
