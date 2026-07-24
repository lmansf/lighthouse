/**
 * §45: keyboard-aware follow-up centering — the decision, as a pure verdict fn
 * (the house pure-verdict pattern, CONVENTIONS.md). When the software keyboard
 * opens on a touch phone, ChatPanel scrolls the transcript so the last answer's
 * tail and the composer sit in the reduced visualViewport — the user sees what
 * they are replying to and typing. Keeping the trigger a pure function of the
 * shell state makes it a table the tests pin, not control flow buried in an
 * effect.
 *
 * TRUE only on the compact + coarse arrangement with the keyboard up:
 *  - compact: the phone/narrow arrangement — desktop and iPad-regular (both
 *    NOT compact) never center, so the desktop tree is untouched.
 *  - coarse: a touch pointer — a fine pointer (mouse/trackpad) summons no
 *    on-screen keyboard, so there is nothing to clear.
 *  - keyboardUp: the software keyboard is up (visualViewport shrank OR an
 *    editable holds focus — the shell's combined signal).
 *
 * [§2 adds the `!streaming` gate: while an ask is in flight the read-from-top
 *  hold owns scroll; the follow-up centering is for the settled composing state.]
 */
export interface KeyboardCenterInput {
  /** The phone/narrow arrangement (desktop + iPad-regular are false). */
  compact: boolean;
  /** A touch pointer — a fine pointer never pops a software keyboard. */
  coarse: boolean;
  /** The software keyboard is up (visualViewport inset OR an editable focused). */
  keyboardUp: boolean;
}

/** Whether ChatPanel should center the last answer + composer above the keyboard. */
export function keyboardCenterVerdict(input: KeyboardCenterInput): boolean {
  return input.compact && input.coarse && input.keyboardUp;
}
