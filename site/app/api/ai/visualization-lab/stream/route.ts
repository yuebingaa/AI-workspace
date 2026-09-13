import { handleHarnessRequest } from "../../harness/handler";

export const runtime = "nodejs";

export function POST(request: Request) {
  return handleHarnessRequest(request, true, { visualizationLab: true });
}
