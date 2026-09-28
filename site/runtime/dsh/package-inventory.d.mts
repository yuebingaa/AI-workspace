export interface DshInstalledPackage {
  id: string; version: string; description: string;
  category: 'bundle' | 'client' | 'tool' | 'runtime'; dependencies: string[];
}
export interface DshPackageInventorySnapshot {
  source: 'managed-installation'; complete: boolean; packages: DshInstalledPackage[];
  issues: { id: string; code: 'metadata-unavailable' }[];
}
export function readDshPackageInventory(root: string): Promise<DshPackageInventorySnapshot>;
