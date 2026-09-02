import type { OwnershipScope } from "../ownership";

export interface DemoRequestIdentity extends OwnershipScope {
  identityMode: "demo-single-user";
}

/**
 * This identity is deliberately server-owned and single-user. It is not read from
 * request headers or cookies, so clients cannot claim another owner. Replace this
 * resolver with verified authentication before exposing uploaded data publicly.
 */
const DEMO_REQUEST_IDENTITY: DemoRequestIdentity = Object.freeze({
  tenantId: "tenant_demo_local",
  ownerId: "owner_demo_workspace",
  identityMode: "demo-single-user",
});

export const DEMO_IDENTITY_RESPONSE_HEADERS = {
  "x-datacanvas-identity-mode": DEMO_REQUEST_IDENTITY.identityMode,
} as const;

export function resolveDemoRequestIdentity(): DemoRequestIdentity {
  return DEMO_REQUEST_IDENTITY;
}
