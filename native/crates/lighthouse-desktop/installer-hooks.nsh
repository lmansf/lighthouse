; Lighthouse NSIS hooks — wired via tauri.conf.json (bundle.windows.nsis.installerHooks).
;
; Why this exists: the app supervises helper processes that keep DLLs inside
; $INSTDIR loaded — llama-server.exe (chat model on 8080, embedding model on
; 8091). The installer template only terminates Lighthouse.exe itself, and
; does so with a hard TerminateProcess, so the shell's exit cleanup never runs
; and the helpers survive as orphans. A loaded DLL is an unwritable file on
; Windows, so extraction then fails with "Error opening file for writing:
; ...\llm\ggml-base.dll" (0.6.x field reports — every 0.6.x install runs the
; embedding server, so this hit anyone upgrading over a running or crashed
; app). Killing by image name is deliberate: an orphan's parent is gone, so
; there is nothing more precise left to match on, and the name ships with
; Lighthouse.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping Lighthouse helper processes..."
  nsExec::ExecToLog 'taskkill /F /T /IM llama-server.exe'
  Pop $0
  Sleep 500 ; let the OS release the DLL locks before extraction begins
  ; An update's hard-kill of the running app must never read as a crash:
  ; boot_guard.rs flags a launch that died young ("booting" marker left
  ; behind) and the NEXT boot comes up in sticky safe mode — reduced
  ; graphics, background features off. Clearing the in-flight marker here
  ; gives the post-update launch a clean history.
  Delete "$APPDATA\com.lighthouse.app\boot-state"
!macroend

; The uninstaller removes the same locked files — same treatment.
!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'taskkill /F /T /IM llama-server.exe'
  Pop $0
  Sleep 500
!macroend
