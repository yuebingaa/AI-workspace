import { handleHarnessRequest } from "./handler";
export const runtime = "nodejs";
export function POST(request: Request) { return handleHarnessRequest(request); }
