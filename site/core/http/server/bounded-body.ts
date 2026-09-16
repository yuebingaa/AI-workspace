// Compatibility entry for existing server consumers. The implementation uses
// standard Web streams and is intentionally shared with browser clients.
export { BoundedBodyError, readBoundedBodyBytes, readBoundedUtf8Body } from "../bounded-body";
export type { BoundedBodyErrorCode } from "../bounded-body";
