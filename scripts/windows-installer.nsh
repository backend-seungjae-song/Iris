# 기존 프로세스·설치 폴더 보존
!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\iris-install-guard.ps1 "${PROJECT_DIR}\scripts\windows-install-guard.ps1"
  !ifdef BUILD_UNINSTALLER
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\iris-install-guard.ps1" -Directory "$INSTDIR" -Uninstall'
  !else
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\iris-install-guard.ps1" -Directory "$INSTDIR"'
  !endif
  Pop $R0
  Pop $R1
  ${If} $R0 != 0
    DetailPrint "$R1"
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend
