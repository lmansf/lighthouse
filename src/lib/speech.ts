/**
 * On-device text-to-speech via the Web Speech API (`speechSynthesis`).
 *
 * Uses the OS's installed voices - nothing is sent to the cloud, so reading
 * answers aloud stays consistent with Lighthouse's local-first promise. Safe to
 * call when unsupported (it just no-ops).
 */

/** Whether the runtime can speak (browser/Electron with speechSynthesis). */
export function isSpeechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * Reduce Markdown to plain, speakable text: drop code fences, inline code,
 * emphasis/heading markers, list bullets, blockquotes, and link syntax (keeping
 * the link text). Keeps it readable rather than spelling out punctuation.
 */
export function markdownToSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " code block. ") // fenced code → a short note
    .replace(/`([^`]+)`/g, "$1") // inline code → its text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images → nothing
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → link text
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
    .replace(/^\s{0,3}>\s?/gm, "") // blockquotes
    .replace(/^\s*[-*+]\s+/gm, "") // bullet list markers
    .replace(/^\s*\d+\.\s+/gm, "") // ordered list markers
    .replace(/(\*\*|__|\*|_|~~)/g, "") // bold/italic/strike markers
    .replace(/\|/g, " ") // table pipes
    .replace(/\n{2,}/g, ". ") // paragraph breaks → a pause
    .replace(/\s+/g, " ")
    .trim();
}

/** Stop any in-progress speech. */
export function stopSpeaking(): void {
  if (isSpeechSupported()) window.speechSynthesis.cancel();
}

/**
 * Speak `text` (Markdown is reduced first). Cancels anything already speaking so
 * a new request interrupts the old. `onEnd` fires when speech finishes or is
 * cancelled, so callers can clear their "speaking" UI state.
 */
export function speak(text: string, onEnd?: () => void): void {
  if (!isSpeechSupported()) {
    onEnd?.();
    return;
  }
  const clean = markdownToSpeech(text);
  if (!clean) {
    onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.rate = 1;
  utterance.onend = () => onEnd?.();
  utterance.onerror = () => onEnd?.();
  window.speechSynthesis.speak(utterance);
}
