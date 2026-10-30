@echo off
setlocal
rem ===========================================================================
rem  DSHBar MCP launcher
rem
rem  Runs the DSHBar MCP server as a REAL Node.js process over stdio.
rem  It is a separate process from DSHBar.exe (the tray GUI); the two share
rem  only the JSON store file (%APPDATA%\DSHBar\store.json by default).
rem
rem  Why a standalone Node process and not the Electron app:
rem    - Electron's main process does not attach the parent's stdin/stdout
rem      pipes, so an MCP child forked from inside Electron can never receive
rem      requests and its stdout is never visible to the MCP client.
rem    - Chromium rejects any unregistered command-line switch ("bad option"),
rem      so MCP mode cannot even be requested via a flag.
rem    - Plain Node.js cannot read files inside app.asar, which is why the CLI
rem      is shipped as a plain file tree next to this launcher.
rem
rem  Layout expected next to this file:
rem    dshbar-mcp\dist\mcp\cli.js    <- the MCP server
rem    dshbar-mcp\vendor\...         <- self-contained dependency closure
rem ===========================================================================

rem --- locate the MCP server -------------------------------------------------
set "CLI=%~dp0dshbar-mcp\dist\mcp\cli.js"
if not exist "%CLI%" (
  echo [dshbar-mcp] ERROR: MCP server not found at "%CLI%". 1>&2
  exit /b 1
)

rem --- resolve a Node.js runtime --------------------------------------------
rem Prefer real node.exe installs; fall back to whatever `node` is on PATH.
set "NODE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "D:\node\node.exe" set "NODE=D:\node\node.exe"
if not defined NODE for %%I in (node.exe) do if not defined NODE if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"
if not defined NODE (
  echo [dshbar-mcp] ERROR: Node.js 18+ not found. 1>&2
  echo [dshbar-mcp] Install Node.js from https://nodejs.org/ and retry. 1>&2
  exit /b 1
)

rem --- point Node at the shipped dependency closure -------------------------
rem The closure is named `vendor` (not `node_modules`) because electron-builder
rem strips every node_modules folder out of extraResources; NODE_PATH bridges
rem module resolution to it.
set "NODE_PATH=%~dp0dshbar-mcp\vendor"

rem --- run the MCP server, forwarding all arguments -------------------------
"%NODE%" "%CLI%" %*
endlocal
