@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
title 创作有数
"%~dp0runtime\node.exe" "%~dp0runtime\launcher.mjs" stop
if errorlevel 1 (
  if not defined WORKBENCH_NO_BROWSER pause
  exit /b 1
)
