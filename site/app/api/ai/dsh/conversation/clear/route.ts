import { clearHarnessConversation } from "../../../harness/conversation/handler";
export const runtime = "nodejs";
export function DELETE(request: Request) { return clearHarnessConversation(request, { dshConversation: true }); }
