import { clearHarnessConversation } from "./handler";

export const runtime = "nodejs";
export function DELETE(request: Request) { return clearHarnessConversation(request); }
