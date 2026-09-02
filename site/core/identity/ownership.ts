export interface OwnershipScope {
  tenantId: string;
  ownerId: string;
}

export function sameOwnership(left: OwnershipScope, right: OwnershipScope): boolean {
  return left.tenantId === right.tenantId && left.ownerId === right.ownerId;
}

export function ownershipNamespace(scope: OwnershipScope): string {
  return JSON.stringify([scope.tenantId, scope.ownerId]);
}
