; Custom uninstall step for Lighthouse (electron-builder NSIS `include` hook).
;
; On uninstall, offer to also delete the user's Lighthouse data. The default is
; NO (keep data) so uninstalling never destroys someone's documents by accident,
; and a silent uninstall (/S) keeps data too. Choosing Yes removes the app
; settings/logs (%APPDATA%\Lighthouse) and the DEFAULT vault folder
; (Documents\Lighthouse Vault). A vault the user pointed elsewhere is left alone.
!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "Also delete your Lighthouse data?$\r$\n$\r$\nThis removes your app settings and the default vault folder (Documents\Lighthouse Vault) along with the files you added to it. Choose No to keep your documents and settings (so a reinstall picks up where you left off)." \
    /SD IDNO IDNO LighthouseKeepData
    RMDir /r "$APPDATA\Lighthouse"
    RMDir /r "$DOCUMENTS\Lighthouse Vault"
  LighthouseKeepData:
!macroend
