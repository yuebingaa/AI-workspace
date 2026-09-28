import { dshWebDocument } from "@/core/dsh-web/server/assets";
export const runtime = "nodejs";
export const GET = (request: Request) => dshWebDocument(request);
