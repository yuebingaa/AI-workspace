import { dshWebAsset } from "@/core/dsh-web/server/assets";
export const runtime = "nodejs";
export const GET = (request: Request) => dshWebAsset(request);
