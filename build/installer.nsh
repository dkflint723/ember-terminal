; Extra installer behaviour, on top of what electron-builder generates.
;
; Windows does not let a program pin itself to the taskbar. The `taskbarpin` verb
; was removed in Windows 10 and the replacement is user-initiated only, so an
; installer checkbox promising it would either do nothing or rely on undocumented
; COM that Microsoft breaks on purpose. Rather than ship a control that lies, the
; installer makes pinning as short as it can honestly be: it leaves a Start Menu
; entry and a desktop shortcut, either of which pins in one right-click, and the
; finish page says so.

!macro customInstall
  ; The Start Menu shortcut carries the AppUserModelID the app sets at runtime, so
  ; a window launched from it groups under that icon on the taskbar instead of
  ; appearing as a second, unnamed button.
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" \
    "AppUserModelID" "dev.dkflint.ember"
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
!macroend

; A custom finish page was tried here and removed: replacing it means taking over
; the "run now" checkbox as well, which is wired to a generated function whose name
; is electron-builder's business and not stable. The guidance about pinning belongs
; in the app's own first run instead, where it can be shown once and dismissed.
