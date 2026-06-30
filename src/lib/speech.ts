/**
 * Read-aloud text-to-speech for chat answers.
 *
 * Primary path: a local neural voice (Piper) served by `/api/tts` - realistic
 * speech synthesized entirely on-device, in keeping with Lighthouse's local-first
 * promise (the answer text never leaves the machine). When that voice isn't
 * bundled or synthesis fails, we fall back to the OS's Web Speech voices so
 * read-aloud still works everywhere. Safe to call when nothing is available (it
 * just no-ops via `onEnd`).
 */

/** Whether the runtime can speak at all (used to gate the read-aloud controls). */
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
 * single Web Speech utterance after ~15s, so the fallback path must speak a long
 * answer as a queue of shorter utterances rather than one big one.
 */
function chunkForSpeech(text: string): string[] {
  return text.match(/[^.!?]+[.!?]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
}

// A single in-flight request at a time. `token` increments on every speak()/
// stopSpeaking(); a request only acts while its token is still current, so a
// newer request (or a stop) cleanly supersedes an older one and each request's
// `onEnd` fires exactly once. The audio element / abort controller / utterance
// are held at module scope so playback can be stopped and isn't GC'd mid-flight.
let token = 0;
let activeOnEnd: (() => void) | null = null;
let activeAudio: HTMLAudioElement | null = null;
let activeAbort: AbortController | null = null;
let activeUtterance: SpeechSynthesisUtterance | null = null;

/** Release whatever is currently playing (audio, fetch, or Web Speech queue). */
function teardown(): void {
  if (activeAbort) {
    try {
      activeAbort.abort();
    } catch {
      /* already settled */
    }
    activeAbort = null;
  }
  if (activeAudio) {
    activeAudio.onended = null;
    activeAudio.onerror = null;
    try {
      activeAudio.pause();
    } catch {
      /* not playing */
    }
    const src = activeAudio.src;
    activeAudio.src = "";
    if (src.startsWith("blob:")) URL.revokeObjectURL(src);
    activeAudio = null;
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  activeUtterance = null;
}

/** Stop any in-progress speech and settle its `onEnd`. */
export function stopSpeaking(): void {
  token++;
  const settle = activeOnEnd;
  activeOnEnd = null;
  teardown();
  settle?.();
}

/**
 * Speak `text` (Markdown is reduced first). Cancels anything already speaking so
 * a new request interrupts the old. `onEnd` fires once when the whole text
 * finishes, when synthesis can't run, or when stopSpeaking cancels it, so callers
 * can clear their "speaking" UI state.
 */
export function speak(text: string, onEnd?: () => void): void {
  const clean = markdownToSpeech(text);
  if (!clean || typeof window === "undefined") {
    onEnd?.();
    return;
  }
  // Interrupt and settle any previous request, then claim the queue.
  stopSpeaking();
  const myToken = ++token;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    if (token === myToken) {
      activeOnEnd = null;
      teardown();
    }
    onEnd?.();
  };
  activeOnEnd = settle;

  // Primary: synthesize with the local neural voice and play the returned WAV.
  const abort = new AbortController();
  activeAbort = abort;
  fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: clean }),
    signal: abort.signal,
  })
    .then(async (r) => {
      if (token !== myToken) return; // superseded mid-flight
      if (!r.ok) throw new Error(`tts ${r.status}`); // 501 ⇒ fall back to OS voice
      const buf = await r.arrayBuffer();
      if (token !== myToken) return;
      activeAbort = null;
      const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
      const audio = new Audio(url);
      activeAudio = audio;
      audio.onended = settle;
      audio.onerror = () => speakWithWebSpeech(clean, myToken, settle);
      audio.play().catch(() => speakWithWebSpeech(clean, myToken, settle));
    })
    .catch((e) => {
      if (token !== myToken || (e instanceof DOMException && e.name === "AbortError")) return;
      // No local voice (or the request failed): fall back to the OS voices.
      speakWithWebSpeech(clean, myToken, settle);
    });
}

/** Fallback: speak via the browser's Web Speech voices, chunked for Chromium. */
function speakWithWebSpeech(clean: string, myToken: number, settle: () => void): void {
  if (!isSpeechSupported()) {
    settle();
    return;
  }
  const chunks = chunkForSpeech(clean);
  let index = 0;
  const speakNext = () => {
    if (token !== myToken) return; // superseded or stopped
    if (index >= chunks.length) {
      settle();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(chunks[index++]);
    utterance.rate = 1;
    utterance.onend = speakNext;
    utterance.onerror = () => settle();
    activeUtterance = utterance;
    window.speechSynthesis.speak(utterance);
  };
  speakNext();
}
