/**
 * Regression test for on-device read-aloud TTS (src/lib/speech.ts).
 *
 * The feature reads finished chat answers aloud through the Web Speech API
 * (`speechSynthesis`), using the OS's voices so nothing leaves the machine. The
 * review hardening this guards:
 *
 *   1. A long answer is spoken as a *sequential queue of sentence-sized
 *      utterances*, not one big utterance - Chromium silently stops a single
 *      utterance after ~15s, so the queue is what lets a long answer finish.
 *   2. The active utterance is held at module scope (a reference) so the browser
 *      can't GC it and drop its onend/onerror mid-playback. Observable here as:
 *      the queue actually advances through every chunk to completion.
 *   3. `onEnd` fires *exactly once* - whether the queue finishes naturally, is
 *      stopped, or is superseded by a newer speak() (the per-answer button and
 *      the auto-speak both rely on this to clear their "speaking" UI state).
 *   4. Markdown is reduced to plain speakable text first.
 *
 * speechSynthesis isn't available under `node --test`, so we install a minimal
 * fake that records what gets spoken and fires `onend` asynchronously (like a
 * real engine finishing a chunk). This drives the real queue logic.
 *
 * Run: `npm run test:extract`
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// ---- Minimal Web Speech API fake (installed before importing speech.ts) ----
class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.rate = 1;
    this.onend = null;
    this.onerror = null;
  }
}

const synth = {
  spoken: [], // text of every utterance handed to speak(), in order
  cancelCount: 0,
  _pending: [],
  speak(u) {
    this.spoken.push(u.text);
    this._pending.push(u);
    // A real engine fires onend asynchronously when the chunk finishes.
    u._timer = setTimeout(() => {
      this._pending = this._pending.filter((x) => x !== u);
      u.onend?.();
    }, 0);
  },
  cancel() {
    this.cancelCount += 1;
    for (const u of this._pending) clearTimeout(u._timer);
    this._pending = [];
  },
  reset() {
    this.spoken = [];
    this.cancelCount = 0;
    for (const u of this._pending) clearTimeout(u._timer);
    this._pending = [];
  },
};

globalThis.window = { speechSynthesis: synth };
globalThis.SpeechSynthesisUtterance = FakeUtterance;

// speak() now tries the local neural voice at /api/tts first and only falls back
// to Web Speech when that route is unavailable. Under `node --test` there is no
// server, so stand in a fetch that answers 501 ("local TTS unavailable") - exactly
// what the route returns in dev / plain-web - to drive the Web Speech fallback the
// rest of these tests exercise.
globalThis.fetch = () => Promise.resolve({ ok: false, status: 501 });

const { speak, stopSpeaking, markdownToSpeech, isSpeechSupported } = await import(
  "../src/lib/speech.ts"
);

/** Resolve when speak()'s onEnd fires (once the queue drains or is cancelled). */
const speakAndWait = (text) => new Promise((resolve) => speak(text, resolve));

// The fallback is reached only after the async /api/tts attempt settles. Drain the
// microtask queue (without advancing timers, so the fake engine's setTimeout-based
// onend can't run) until the fallback's first utterance has been handed over.
const flushToFallback = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

test("isSpeechSupported() detects the fake speechSynthesis", () => {
  assert.equal(isSpeechSupported(), true);
});

test("a long multi-sentence answer is spoken as a sequential queue, finishing every chunk", async () => {
  synth.reset();
  const answer =
    "First sentence here. Second one follows! And a third? Then a final fourth sentence.";
  await speakAndWait(answer);

  // One utterance per sentence (the ~15s-cutoff hardening), spoken in order.
  assert.deepEqual(synth.spoken, [
    "First sentence here.",
    "Second one follows!",
    "And a third?",
    "Then a final fourth sentence.",
  ]);
  // The whole queue drained - nothing left mid-playback.
  assert.equal(synth._pending.length, 0);
});

test("onEnd fires exactly once when the queue finishes naturally", async () => {
  synth.reset();
  let ends = 0;
  await new Promise((resolve) =>
    speak("One. Two. Three.", () => {
      ends += 1;
      resolve();
    }),
  );
  await new Promise((r) => setTimeout(r, 5)); // let any stray timers run
  assert.equal(ends, 1);
  assert.deepEqual(synth.spoken, ["One.", "Two.", "Three."]);
});

test("stopSpeaking() cancels the rest of the queue and settles onEnd once", async () => {
  synth.reset();
  let ends = 0;
  speak("Alpha. Bravo. Charlie. Delta.", () => {
    ends += 1;
  });
  // Once the /api/tts attempt has fallen back, only the first chunk has been
  // handed to the engine; the rest wait behind its onend.
  await flushToFallback();
  assert.deepEqual(synth.spoken, ["Alpha."]);

  stopSpeaking(); // user hit stop / started a new question
  assert.equal(ends, 1, "onEnd settled exactly once on stop");
  assert.ok(synth.cancelCount >= 1, "speechSynthesis.cancel() was called");

  await new Promise((r) => setTimeout(r, 5)); // ensure no late chunks slip through
  assert.deepEqual(synth.spoken, ["Alpha."], "no further chunks after stop");
  assert.equal(ends, 1, "onEnd still only fired once");
});

test("a newer speak() supersedes the old queue, and the old onEnd fires once", async () => {
  synth.reset();
  let firstEnds = 0;
  speak("Old one. Old two. Old three.", () => {
    firstEnds += 1;
  });
  await flushToFallback();
  assert.deepEqual(synth.spoken, ["Old one."]);

  // A second answer interrupts the first before it finishes.
  await speakAndWait("New one. New two.");

  assert.equal(firstEnds, 1, "the superseded request settled exactly once");
  // The new queue ran to completion after interrupting.
  assert.ok(synth.spoken.includes("New one."));
  assert.ok(synth.spoken.includes("New two."));
});

test("markdownToSpeech reduces Markdown to plain speakable text", () => {
  const md = [
    "# Heading",
    "",
    "Here is **bold** and *italic* and `inline code` and a [link](https://x.com).",
    "",
    "- bullet one",
    "- bullet two",
    "",
    "```",
    "code to skip",
    "```",
  ].join("\n");

  const spoken = markdownToSpeech(md);
  assert.ok(!spoken.includes("#"), "no heading marker");
  assert.ok(!spoken.includes("**") && !spoken.includes("*"), "no emphasis markers");
  assert.ok(!spoken.includes("`"), "no inline-code backticks");
  assert.ok(!spoken.includes("https://x.com"), "link URL dropped");
  assert.ok(spoken.includes("link"), "link text kept");
  assert.ok(spoken.includes("bold") && spoken.includes("italic"), "emphasized words kept");
  assert.ok(spoken.includes("code block"), "fenced code reduced to a short note");
  assert.ok(!spoken.includes("code to skip"), "fenced code body not read aloud");
});

test("speaking nothing (empty / whitespace-only) settles onEnd without an utterance", async () => {
  synth.reset();
  let ends = 0;
  await new Promise((resolve) =>
    speak("   \n  ", () => {
      ends += 1;
      resolve();
    }),
  );
  assert.equal(ends, 1);
  assert.equal(synth.spoken.length, 0, "nothing handed to the engine");
});
