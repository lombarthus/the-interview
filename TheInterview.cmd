@echo off
rem The Interview — Launcher. Startet den Node-Server (der die Sprach-Engine mitstartet) und
rem öffnet den Browser. Alles lokal auf 127.0.0.1; Daten unter %LOCALAPPDATA%\TheInterview.
setlocal
set "ROOT=%~dp0"
set "NODE=%ROOT%runtime\node\node.exe"
if not exist "%NODE%" set "NODE=node"
title The Interview
echo The Interview startet ... (dieses Fenster kann minimiert bleiben; schliessen beendet die App)
"%NODE%" "%ROOT%app\server.js" %*
if errorlevel 1 (
  echo.
  echo Der Server hat sich mit einem Fehler beendet. Protokoll: %LOCALAPPDATA%\TheInterview\logs
  pause
)
