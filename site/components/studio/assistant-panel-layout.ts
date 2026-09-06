export const ASSISTANT_PANEL_MIN_WIDTH = 300;
export const ASSISTANT_PANEL_MAX_WIDTH = 720;

export interface AssistantPanelWidthBounds {
  minimum: number;
  maximum: number;
}

export function getAssistantPanelWidthBounds(viewportWidth: number, pagesExpanded: boolean): AssistantPanelWidthBounds {
  const safeViewportWidth = Math.max(0, Math.round(viewportWidth));
  if (safeViewportWidth <= 960) {
    const maximum = Math.max(0, safeViewportWidth - 44);
    return {
      minimum: Math.min(ASSISTANT_PANEL_MIN_WIDTH, maximum),
      maximum,
    };
  }

  const compactDesktop = safeViewportWidth <= 1200;
  const pagesWidth = pagesExpanded
    ? compactDesktop ? 210 : 250
    : compactDesktop ? 52 : 56;
  const reservedCanvasWidth = compactDesktop ? 360 : 560;
  const maximum = Math.max(
    ASSISTANT_PANEL_MIN_WIDTH,
    Math.min(ASSISTANT_PANEL_MAX_WIDTH, safeViewportWidth - pagesWidth - reservedCanvasWidth),
  );

  return { minimum: ASSISTANT_PANEL_MIN_WIDTH, maximum };
}

export function clampAssistantPanelWidth(width: number, viewportWidth: number, pagesExpanded: boolean): number {
  const bounds = getAssistantPanelWidthBounds(viewportWidth, pagesExpanded);
  return Math.min(bounds.maximum, Math.max(bounds.minimum, Math.round(width)));
}
