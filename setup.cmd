@echo off
setlocal DisableDelayedExpansion
set "ROOT=%~dp0"
set "PSModulePath=%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules"
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\setup-win.ps1" %*
exit /b %ERRORLEVEL%
