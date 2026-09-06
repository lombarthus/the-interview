@echo off
rem Entwicklungsstart aus dem Repo: nutzt node aus dem PATH und uv aus dem PATH.
rem Optional: dev.cmd <Datenordner>   (Vorgabe %LOCALAPPDATA%\TheInterview)
setlocal
if not "%~1"=="" set "INTERVIEW_HOME=%~1"
set "INTERVIEW_NO_BROWSER=%INTERVIEW_NO_BROWSER%"
node "%~dp0app\server.js"
