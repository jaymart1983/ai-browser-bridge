@echo off
rem run-bridge.cmd — Windows launcher for Browser Bridge.
rem The scheduled task runs THIS (not node.exe directly) so a staged runtime update
rem (runtime\node.new, written by the self-updater while node.exe was locked) is
rem swapped into place before the bridge starts.
setlocal
set "DIR=%~dp0"
if exist "%DIR%runtime\node.new" (
  move /y "%DIR%runtime\node.new" "%DIR%runtime\node.exe" >nul 2>&1
)
"%DIR%runtime\node.exe" "%DIR%bridge\server.mjs"
