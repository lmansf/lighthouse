/**
 * §42 §1: the on-device availability verdict — the TS twin of
 * lighthouse-shell/src/commands.rs::private_model_verdict (PARITY: same
 * table, same strings; test/privateModelIos.test.mjs pins the same cases on
 * both sides). The web dev flow never probes a Swift bridge — this module
 * exists so the verdict TABLE is one artifact reviewed in two languages,
 * exactly like the budget tier registry.
 *
 * Codes (PrivateModelServer.swift): 1 FM available · 2 llama available ·
 * 0 AI not enabled · -1 device ineligible · -2 model preparing · -3 OS too
 * old · -5 listener failed · -6 build without support · -7 model absent
 * (capable device — offer the ~1.1 GB download) · -8 device below the memory
 * bar (never an offer) · -9 memory tight right now (re-probe).
 */

export interface PrivateModelVerdict {
  available: boolean;
  tier: "foundation" | "llama" | "none";
  reason: string | null;
  /** The roster may offer the ~1.1 GB model download (ONLY code -7). */
  download: boolean;
}

export function privateModelVerdict(code: number, portOk: boolean): PrivateModelVerdict {
  if ((code === 1 || code === 2) && portOk) {
    return {
      available: true,
      tier: code === 2 ? "llama" : "foundation",
      reason: null,
      download: false,
    };
  }
  let reason: string;
  let download = false;
  switch (code) {
    case 1:
    case 2:
      reason = "the on-device private model could not be started";
      break;
    case 0:
      reason = "Apple Intelligence is not enabled on this device";
      break;
    case -1:
      reason = "this device is not eligible for Apple Intelligence";
      break;
    case -2:
      reason = "the on-device model is still preparing — try again shortly";
      break;
    case -3:
      reason = "the on-device private model requires iOS 26 or later";
      break;
    case -5:
      reason = "the on-device private model could not be started";
      break;
    case -6:
      reason = "this app build doesn't include on-device model support — update the app";
      break;
    case -7:
      reason = "the private model for this device is a ~1.1 GB download";
      download = true;
      break;
    case -8:
      reason = "this device can't hold the private model";
      break;
    case -9:
      reason = "not enough free memory for the private model right now — try again after closing some apps";
      break;
    default:
      reason = "the on-device private model is unavailable on this device";
  }
  return { available: false, tier: "none", reason, download };
}
