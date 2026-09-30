// Supported Notebook cells use a runtime bridge. V2 definitions are not persisted yet.
export const visualizationCapabilities = {
  schemaVersion: 2, productEnabled: true, productScope: "notebook-compatible-runtime-bridge", marks: ["bar", "line", "area"],
  maxMeasures: 1, maxDimensions: 4, timezone: "UTC", nullCountedByDistinct: false,
  exactDecimalMeasures: false, timestampBucketing: false, facets: true, maxFacetPanels: 36,
  rendererX: "non-null-string-or-date", continuousTimeAxis: false,
  maxInputRows: 50_000, maxResultRows: 1000, maxInputBytes: 16 * 1024 * 1024,
  maxResultBytes: 2 * 1024 * 1024,
} as const;
