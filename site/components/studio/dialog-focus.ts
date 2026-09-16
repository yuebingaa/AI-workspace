import type { KeyboardEvent } from "react";

/** Keep Tab in the settings content, including when the browser would focus its chrome. */
export function containDialogFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex='0']")]
    .filter(element => element.getClientRects().length > 0);
  const first = controls[0], last = controls.at(-1);
  if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); return; }
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
