; Lighthouse NSIS hooks — wired via tauri.conf.json (bundle.windows.nsis.installerHooks).
;
; Why this exists: the app supervises helper processes that keep DLLs inside
; $INSTDIR loaded — llama-server.exe (chat model on 8080, embedding model on
; 8091) and piper.exe (read-aloud, spawned per utterance). The installer
; template only terminates Lighthouse.exe itself, and does so with a hard
; TerminateProcess, so the shell's exit cleanup never runs and the helpers
; survive as orphans. A loaded DLL is an unwritable file on Windows, so
; extraction then fails with "Error opening file for writing:
; ...\llm\ggml-base.dll" (0.6.x field reports — every 0.6.x install runs the
; embedding server, so this hit anyone upgrading over a running or crashed
; app). Killing by image name is deliberate: an orphan's parent is gone, so
; there is nothing more precise left to match on, and both names ship with
; Lighthouse.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping Lighthouse helper processes..."
  nsExec::ExecToLog 'taskkill /F /T /IM llama-server.exe'
  Pop $0
  nsExec::ExecToLog 'taskkill /F /T /IM piper.exe'
  Pop $0
  Sleep 500 ; let the OS release the DLL locks before extraction begins
!macroend

; The uninstaller removes the same locked files — same treatment.
!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'taskkill /F /T /IM llama-server.exe'
  Pop $0
  nsExec::ExecToLog 'taskkill /F /T /IM piper.exe'
  Pop $0
  Sleep 500
!macroend
