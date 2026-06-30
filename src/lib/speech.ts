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

/**
 * Split speakable text into sentence-sized chunks. Chromium silently stops a
 * single utterance after ~15s, so a long answer must be spoken as a queue of
 * shorter utterances rather than one big one.
 */
function chunkForSpeech(text: string): string[] {
  return text.match(/[^.!?]+[.!?]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
}

// The utterance currently being spoken, held at module scope so Chromium can't
// garbage-collect it (and drop onend/onerror) before playback finishes.
// `activeOnEnd` is the in-flight request's settle function; it doubles as the
// identity check that lets a newer speak()/stopSpeaking() supersede the old
// queue, so a request's onEnd fires exactly once.
let activeUtterance: SpeechSynthesisUtterance | null = null;
let activeOnEnd: (() => void) | null = null;

/** Stop any in-progress speech and clear the queue. */
export function stopSpeaking(): void {
  if (!isSpeechSupported()) return;
  const settle = activeOnEnd;
  activeOnEnd = null;
  activeUtterance = null;
  window.speechSynthesis.cancel();
  settle?.();
}

/**
 * Speak `text` (Markdown is reduced first). Cancels anything already speaking so
 * a new request interrupts the old. `onEnd` fires once when the whole text
 * finishes or when stopSpeaking cancels it, so callers can clear their
 * "speaking" UI state.
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
  // Interrupt and settle any previous request, then claim the queue.
  stopSpeaking();
  const chunks = chunkForSpeech(clean);
  let index = 0;
  let settled = false;

  const settle = () => {
    if (settled) return;
    settled = true;
    if (activeOnEnd === settle) {
      activeOnEnd = null;
      activeUtterance = null;
    }
    onEnd?.();
  };
  activeOnEnd = settle;

  const speakNext = () => {
    if (activeOnEnd !== settle) return; // superseded or stopped
    if (index >= chunks.length) {
      settle();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(chunks[index++]);
    utterance.rate = 1;
    utterance.onend = speakNext;
    utterance.onerror = settle;
    activeUtterance = utterance;
    window.speechSynthesis.speak(utterance);
  };

  speakNext();
}
