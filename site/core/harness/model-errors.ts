import type { HarnessModelResult } from "./contracts";

/** Fatal provider-contract violation; never silently fall back to another model. */
export class HarnessModelProtocolError extends Error {}

export class HarnessModelFormatError extends Error {
  constructor(
    message: string,
    readonly model: string,
    readonly usage: HarnessModelResult["usage"],
  ) {
    super(message);
    this.name = "HarnessModelFormatError";
  }
}
