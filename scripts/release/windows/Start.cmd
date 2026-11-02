@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
"%~dp0runtime\node.exe" "%~dp0runtime\launcher.mjs" start
if errorlevel 1 (
  if not defined WORKBENCH_NO_BROWSER pause
  exit /b 1
)
