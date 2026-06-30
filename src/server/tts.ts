/**
 * Local, on-device neural text-to-speech via Piper (rhasspy/piper).
 *
 * Piper is a fast neural TTS engine (MIT-licensed, ONNX Runtime). It runs
 * entirely on the user's machine, so reading answers aloud stays consistent with
 * Lighthouse's local-first promise - the answer text never leaves the device.
 *
 * The binary + a voice model are bundled into `resources/tts/` at build time by
 * `scripts/fetch-local-model.mjs` and copied into the installer via the
 * `extraResources` entry in package.json. When nothing is bundled (a plain `next
 * dev` run, or the assets weren't fetched), `isLocalTtsAvailable()` is false and
 * callers fall back to the browser's Web Speech voices.
 *
 * ponytail: Piper is spawned per request, so each call pays the model load
 * (~0.5-1s). Fine for reading a single answer; revisit with a persistent process
 * if we ever stream long-form audio.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { resourcesDir } from "./config";

/** Directory holding the bundled Piper binary, its libraries, and the voice. */
function ttsDir(): string {
  return join(resourcesDir(), "tts");
}

/** Absolute path to the Piper executable for this OS (may not exist). */
function piperBin(): string {
  return join(ttsDir(), process.platform === "win32" ? "piper.exe" : "piper");
}

/** The bundled voice model (`*.onnx`), or null if none is present. */
function voiceModel(): string | null {
  try {
    const onnx = readdirSync(ttsDir()).find((f) => f.toLowerCase().endsWith(".onnx"));
    return onnx ? join(ttsDir(), onnx) : null;
  } catch {
    return null; // no tts directory bundled
  }
}

/** True when a Piper binary and a voice model are both bundled and runnable. */
export function isLocalTtsAvailable(): boolean {
  return existsSync(piperBin()) && voiceModel() !== null;
}

/**
 * Synthesize `text` to a WAV buffer with the bundled Piper voice. Piper writes a
 * proper WAV (header + PCM) to an output file, which we read back and delete -
 * robust across platforms (unlike piping raw PCM out of stdout, which would mean
 * reconstructing the header ourselves). Rejects if Piper isn't bundled or fails.
 */
export function synthesize(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const bin = piperBin();
    const voice = voiceModel();
    if (!existsSync(bin) || !voice) {
      reject(new Error("local TTS not bundled"));
      return;
    }
    const outFile = join(tmpdir(), `lh-tts-${randomUUID()}.wav`);
    const args = ["--model", voice, "--output_file", outFile];
    // Piper resolves its phoneme data (espeak-ng) relative to the binary, but
    // pass it explicitly when present so a non-default cwd can't break it.
    const espeakData = join(ttsDir(), "espeak-ng-data");
    if (existsSync(espeakData)) args.push("--espeak_data", espeakData);

    const proc = spawn(bin, args, { cwd: ttsDir(), windowsHide: true });
    const err: Buffer[] = [];
    proc.stderr.on("data", (d) => err.push(d));
    proc.on("error", (e) => {
      rmSync(outFile, { force: true });
      reject(e);
    });
    proc.on("close", (code) => {
      try {
        if (code === 0 && existsSync(outFile)) {
          const wav = readFileSync(outFile);
          rmSync(outFile, { force: true });
          resolve(wav);
        } else {
          rmSync(outFile, { force: true });
          reject(new Error(`piper exited ${code}: ${Buffer.concat(err).toString().slice(0, 300)}`));
        }
      } catch (e) {
        reject(e);
      }
    });
    // If Piper dies early (e.g. an unloadable .onnx that passed existsSync),
    // writing to its closed stdin emits EPIPE here; without this handler it would
    // surface as an uncaughtException and crash the server. 'close' still settles.
    proc.stdin.on("error", (e) => {
      rmSync(outFile, { force: true });
      reject(e);
    });
    proc.stdin.write(text);
    proc.stdin.end();
  });
}
