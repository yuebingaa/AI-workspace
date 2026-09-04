import {
  datasetRepository,
  datasetRepositoryStartupError,
  type DatasetRepositoryHealth,
} from "@/core/datasets/server/dataset-repository";
import {
  excelExportStore,
  excelExportStoreStartupError,
  type ExcelExportStoreHealth,
} from "@/core/exports/server/excel-export-store";
import { DEMO_IDENTITY_RESPONSE_HEADERS } from "@/core/identity/server/demo-identity";

export const runtime = "nodejs";

export function buildHealthPayload(input: {
  datasets: DatasetRepositoryHealth;
  exports: ExcelExportStoreHealth;
  datasetStartupError: string | null;
  exportStartupError: string | null;
  checkedAt?: Date;
}) {
  const { datasets, exports } = input;
  const startupErrors = Number(Boolean(input.datasetStartupError)) + Number(Boolean(input.exportStartupError));
  const runtimeErrors = Number(!datasets.persistenceHealthy) + Number(!exports.persistenceHealthy);
  const warnings = [
    datasets.warning,
    exports.warning,
    datasets.mode === "memory" || exports.mode === "memory" ? "本地持久化未完全启用，进程重启后临时服务端状态可能丢失。" : null,
    startupErrors > 0 ? "本地持久化初始化失败，已安全回退到内存模式。" : null,
    runtimeErrors > 0 ? "本地持久化运行期写入失败，相关业务变更已回滚。" : null,
  ].filter((value): value is string => Boolean(value));
  return {
    status: startupErrors + runtimeErrors > 0 ? "degraded" : "ok",
    checkedAt: (input.checkedAt ?? new Date()).toISOString(),
    identityMode: "demo-single-user",
    persistence: {
      configured: datasets.mode === "json-file" && exports.mode === "json-file",
      startupErrors,
      runtimeErrors,
    },
    datasets,
    exports,
    warnings,
  };
}

export async function GET() {
  return Response.json(buildHealthPayload({
    datasets: datasetRepository.health(),
    exports: excelExportStore.health(),
    datasetStartupError: datasetRepositoryStartupError,
    exportStartupError: excelExportStoreStartupError,
  }), {
    headers: {
      "cache-control": "private, no-store, max-age=0",
      "x-content-type-options": "nosniff",
      ...DEMO_IDENTITY_RESPONSE_HEADERS,
    },
  });
}
