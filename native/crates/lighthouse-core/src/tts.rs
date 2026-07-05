//! Local, on-device neural text-to-speech via Piper (port of `src/server/tts.ts`).
//!
//! The binary + a voice model are bundled into `resources/tts/`; when nothing
//! is bundled `is_local_tts_available()` is false and callers fall back to the
//! browser's Web Speech voices. Piper is spawned per request (same trade-off as
//! the TS engine; a persistent process is a later optimization).

use std::fs;
use std::path::PathBuf;

use crate::config::resources_dir;

fn tts_dir() -> PathBuf {
    resources_dir().join("tts")
}

fn piper_bin() -> PathBuf {
    tts_dir().join(if cfg!(windows) { "piper.exe" } else { "piper" })
}

/// The bundled voice model (`*.onnx`), or None if none is present.
fn voice_model() -> Option<PathBuf> {
    let entries = fs::read_dir(tts_dir()).ok()?;
    for e in entries.flatten() {
        if e.file_name()
            .to_string_lossy()
            .to_lowercase()
            .ends_with(".onnx")
        {
            return Some(e.path());
        }
    }
    None
}

/// True when a Piper binary and a voice model are both bundled.
pub fn is_local_tts_available() -> bool {
    piper_bin().exists() && voice_model().is_some()
}

/// Synthesize `text` to a WAV buffer with the bundled Piper voice. Piper writes
/// a proper WAV to an output file, which we read back and delete.
pub async fn synthesize(text: &str) -> anyhow::Result<Vec<u8>> {
    let bin = piper_bin();
    let voice = voice_model().ok_or_else(|| anyhow::anyhow!("local TTS not bundled"))?;
    if !bin.exists() {
        anyhow::bail!("local TTS not bundled");
    }
    let out_file = std::env::temp_dir().join(format!("lh-tts-{}.wav", uuid::Uuid::new_v4()));

    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("--model")
        .arg(&voice)
        .arg("--output_file")
        .arg(&out_file)
        .current_dir(tts_dir());
    // Piper resolves its phoneme data (espeak-ng) relative to the binary, but
    // pass it explicitly when present so a non-default cwd can't break it.
    let espeak = tts_dir().join("espeak-ng-data");
    if espeak.exists() {
        cmd.arg("--espeak_data").arg(&espeak);
    }
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        // windowsHide equivalent: CREATE_NO_WINDOW
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let cleanup = |f: &PathBuf| {
        let _ = fs::remove_file(f);
    };

    let mut child = cmd.spawn().inspect_err(|_| cleanup(&out_file))?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        // Piper dying early surfaces as a broken pipe here; fall through to the
        // exit-status check rather than crashing.
        let _ = stdin.write_all(text.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
    let output = child
        .wait_with_output()
        .await
        .inspect_err(|_| cleanup(&out_file))?;
    if output.status.success() && out_file.exists() {
        let wav = fs::read(&out_file)?;
        cleanup(&out_file);
        Ok(wav)
    } else {
        cleanup(&out_file);
        let err: String = String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(300)
            .collect();
        anyhow::bail!("piper exited {:?}: {err}", output.status.code())
    }
}
