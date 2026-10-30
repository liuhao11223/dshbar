@echo off
setlocal
rem ===========================================================================
rem  DSHBar 兼容模式启动器
rem
rem  用途：某些机器上 Chromium 的 GPU / 渲染子进程起不来，正常启动会直接退出
rem        （事件查看器里 DSHBar.exe 异常代码 0x80000003）。这个脚本用最保守的
rem        参数启动：彻底关掉硬件加速与 GPU 合成，全部走软件渲染。
rem
rem  同时把 stdout/stderr 落到 %LOCALAPPDATA%\DSHBar\console.log，
rem  这样即使程序在加载 JS 之前就崩了，也能看到 Chromium 的原始报错。
rem
rem  用法：双击本文件。若这次能起来，说明就是 GPU 的问题——可以直接用这个
rem        脚本，或把系统显卡驱动更新后再试正常入口。
rem ===========================================================================

set "APP=%~dp0DSHBar.exe"
if not exist "%APP%" (
  echo [DSHBar] ERROR: DSHBar.exe not found next to this script. 1>&2
  pause
  exit /b 1
)

set "LOGDIR=%LOCALAPPDATA%\DSHBar"
if not defined LOCALAPPDATA set "LOGDIR=%TEMP%"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
set "LOG=%LOGDIR%\console.log"

echo [DSHBar] console log: %LOG%
echo [DSHBar] starting in safe mode ...

rem ELECTRON_RUN_AS_NODE 必须**删除**：置空('')会被 Chromium 当成存在，直接崩。
set "ELECTRON_RUN_AS_NODE="
"%APP%" --disable-gpu --disable-gpu-compositing --disable-gpu-sandbox >> "%LOG%" 2>&1

set "RC=%ERRORLEVEL%"
echo.
echo [DSHBar] exited with code %RC%
echo [DSHBar] log tail:
powershell -NoProfile -Command "if (Test-Path '%LOG%') { Get-Content '%LOG%' -Tail 20 }" 2>nul
echo.
pause
endlocal
