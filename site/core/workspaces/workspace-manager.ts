import type { ChangeSetExecutionState } from "@/core/changesets";
import { assertValidAppSpecDataBindings } from "@/core/data";
import type { AppPage, AppSpec, DataProduct, DatasetReference } from "@/core/models";
import { appSpecSchema, dataProductSchema } from "@/core/schemas";

export const INITIAL_WORKSPACE_PAGE_ID = "page_workspace_start";
export const LEGACY_DEMO_PAGE_IDS = new Set(["page_home", "page_sales", "page_customers"]);

export interface WorkspaceInterfaceSummary {
  id: string;
  label: string;
  description: string;
  dataSourceCount: number;
}

function workspaceRoute(pageId: string): string {
  return `/workspace/${pageId.replace(/^page_workspace_/u, "")}`;
}

function blankPage(pageId: string, title: string): AppPage {
  return {
    id: pageId,
    title,
    route: workspaceRoute(pageId),
    root: {
      id: `root_${pageId}`,
      type: "PageRoot",
      props: {},
      children: [],
    },
  };
}

function parseAppSpec(appSpec: AppSpec): AppSpec {
  const parsed = appSpecSchema.parse(appSpec);
  assertValidAppSpecDataBindings(parsed);
  return parsed;
}

export function ensureInitialBlankWorkspaceInAppSpec(appSpec: AppSpec): AppSpec {
  if (appSpec.pages.some((page) => page.id === INITIAL_WORKSPACE_PAGE_ID)) return appSpec;
  const page = blankPage(INITIAL_WORKSPACE_PAGE_ID, "空白工作界面");
  return parseAppSpec({
    ...appSpec,
    pages: [...appSpec.pages, page],
    navigation: [...appSpec.navigation, {
      id: "nav_workspace_start",
      title: page.title,
      pageId: page.id,
    }],
  });
}

export function ensureInitialBlankWorkspaceInProduct(dataProduct: DataProduct): DataProduct {
  const appSpec = ensureInitialBlankWorkspaceInAppSpec(dataProduct.appSpec);
  return dataProductSchema.parse({
    ...dataProduct,
    datasets: dataProduct.datasets.map((dataset) => {
      if (dataset.workspaceId) return dataset;
      if (dataset.id.startsWith("dataset_eds_") && appSpec.pages.some((page) => page.id === "page_eds_analysis")) {
        return { ...dataset, workspaceId: "page_eds_analysis" };
      }
      return dataset.ephemeral ? { ...dataset, workspaceId: INITIAL_WORKSPACE_PAGE_ID } : dataset;
    }),
    appSpec,
  });
}

export function ensureInitialBlankWorkspaceInExecution(
  execution: ChangeSetExecutionState,
): ChangeSetExecutionState {
  return {
    ...execution,
    present: ensureInitialBlankWorkspaceInAppSpec(execution.present),
    preview: execution.preview ? {
      ...execution.preview,
      appSpec: ensureInitialBlankWorkspaceInAppSpec(execution.preview.appSpec),
    } : null,
    history: execution.history.map((entry) => ({
      ...entry,
      appSpec: ensureInitialBlankWorkspaceInAppSpec(entry.appSpec),
    })),
  };
}

export function createBlankWorkspaceInAppSpec(
  appSpec: AppSpec,
  title: string,
  idFactory: () => string,
): { appSpec: AppSpec; page: AppPage } {
  const normalizedTitle = title.trim().slice(0, 50) || "未命名工作界面";
  const suffix = idFactory().replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 80);
  if (!suffix) throw new Error("无法生成工作界面 ID。");
  const pageId = `page_workspace_${suffix}`;
  if (appSpec.pages.some((page) => page.id === pageId)) throw new Error("工作界面 ID 已存在，请重试。");
  const page = blankPage(pageId, normalizedTitle);
  return {
    page,
    appSpec: parseAppSpec({
      ...appSpec,
      pages: [...appSpec.pages, page],
      navigation: [...appSpec.navigation, {
        id: `nav_workspace_${suffix}`,
        title: page.title,
        pageId,
      }],
    }),
  };
}

export function assignDatasetToWorkspace(
  dataProduct: DataProduct,
  datasetId: string,
  workspaceId: string,
): DataProduct {
  if (!dataProduct.appSpec.pages.some((page) => page.id === workspaceId)) {
    throw new Error("目标工作界面不存在。");
  }
  if (!dataProduct.datasets.some((dataset) => dataset.id === datasetId)) {
    throw new Error("待分配的数据集不存在。");
  }
  return dataProductSchema.parse({
    ...dataProduct,
    datasets: dataProduct.datasets.map((dataset) => (
      dataset.id === datasetId ? { ...dataset, workspaceId } : dataset
    )),
  });
}

export function datasetsForWorkspace(
  datasets: DatasetReference[],
  workspaceId: string,
): DatasetReference[] {
  return datasets.filter((dataset) => dataset.shared || dataset.workspaceId === workspaceId);
}

export function reconcileDataProductWorkspaces(dataProduct: DataProduct, appSpec: AppSpec): DataProduct {
  const validPageIds = new Set(appSpec.pages.map((page) => page.id));
  const fallbackPageId = validPageIds.has(INITIAL_WORKSPACE_PAGE_ID)
    ? INITIAL_WORKSPACE_PAGE_ID
    : appSpec.navigation.find((item) => validPageIds.has(item.pageId))?.pageId ?? appSpec.pages[0]?.id;
  if (!fallbackPageId) throw new Error("至少需要保留一个工作界面。");
  return dataProductSchema.parse({
    ...dataProduct,
    appSpec,
    ...(dataProduct.notebooks ? { notebooks: Object.fromEntries(Object.entries(dataProduct.notebooks).filter(([pageId]) => validPageIds.has(pageId))) } : {}),
    ...(dataProduct.semanticLayer ? { semanticLayer: { ...dataProduct.semanticLayer,
      selectedByWorkspace: Object.fromEntries(Object.entries(dataProduct.semanticLayer.selectedByWorkspace).filter(([pageId]) => validPageIds.has(pageId))),
    } } : {}),
    datasets: dataProduct.datasets.map((dataset) => (
      dataset.workspaceId && !validPageIds.has(dataset.workspaceId)
        ? { ...dataset, workspaceId: fallbackPageId }
        : dataset
    )),
  });
}

export function workspaceInterfaceSummaries(
  appSpec: AppSpec,
  datasets: DatasetReference[],
): WorkspaceInterfaceSummary[] {
  return appSpec.navigation
    .filter((item) => !LEGACY_DEMO_PAGE_IDS.has(item.pageId))
    .filter((item) => appSpec.pages.some((page) => page.id === item.pageId))
    .map((item) => {
      const count = datasetsForWorkspace(datasets, item.pageId).length;
      return {
        id: item.pageId,
        label: item.title,
        dataSourceCount: count,
        description: count
          ? `${count} 份数据 · 可在此界面生成独立看板`
          : "空白界面 · 可导入文件或交给 AI 创建内容",
      };
    });
}
