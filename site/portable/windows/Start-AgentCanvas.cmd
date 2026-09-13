@echo off
chcp 65001 >nul
setlocal
title AgentCanvas Portable
pushd "%~dp0" || goto directory_error

if not exist "runtime\node.exe" (
  echo [ERROR] Missing runtime\node.exe.
  echo Extract the entire ZIP before running this file.
  pause
  popd
  exit /b 1
)

"runtime\node.exe" "launcher.mjs"
set "AGENTCANVAS_EXIT_CODE=%ERRORLEVEL%"
if errorlevel 1 (
  echo.
  echo AgentCanvas failed to start. Review the error above.
  pause
)

popd
exit /b %AGENTCANVAS_EXIT_CODE%

:directory_error
echo [ERROR] Cannot open the AgentCanvas folder.
pause
exit /b 1
