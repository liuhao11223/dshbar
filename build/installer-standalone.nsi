; ============================================================================
; DSHBar · 独立 NSIS 安装器脚本（不依赖 electron-builder）
;
; 为什么存在：electron-builder 的 NSIS 流程要求「执行一次刚生成的安装器」来
; 预产出内嵌卸载器，在受限/无桌面的 CI 会话里这一步必然失败（process failed 2）。
; 本脚本用标准 NSIS 做法：卸载器在**安装时**由 WriteUninstaller 写出，
; 编译期不需要执行安装包，任何环境都能产出成品。
;
; 行为与 electron-builder 版对齐：
;   - 安装到 %LOCALAPPDATA%\Programs\DSHBar（per-user，无需 UAC）
;   - 开始菜单 + 桌面快捷方式；卸载项进「应用和功能」
;   - customInstall 同款 PATH 逻辑：把 <installDir>\resources 加进用户 PATH
;     并广播 WM_SETTINGCHANGE；卸载时精确移除该条目
;   - 卸载前提示先退出 DSHBar（文件被占用时删除会失败）
;
; 编译（本机缓存的 makensis，无需联网）：
;   "%LOCALAPPDATA%\electron-builder\Cache\nsis-3.0.4.1\nsis-3.0.4.1-w8az6\Bin\makensis.exe" ^
;     /DVERSION=0.1.3 /DAPPDIR=release-installer\win-unpacked /DOUTFILE=release-installer "build\installer-standalone.nsi"
; ============================================================================

!ifndef VERSION
  !error "需要 /DVERSION=x.y.z"
!endif
!ifndef APPDIR
  !error "需要 /DAPPDIR=<win-unpacked 目录>"
!endif
!ifndef OUTFILE
  !define OUTFILE "release"
!endif

Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64
ManifestDPIAware true

!define APPNAME "DSHBar"
!define COMPANYNAME "DSHBar Contributors"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"

Name "${APPNAME}"
OutFile "${OUTFILE}\${APPNAME} Setup ${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
InstallDirRegKey HKCU "${UNINSTKEY}" "InstallLocation"
RequestExecutionLevel user

!ifdef ICON
  Icon "${ICON}"
  UninstallIcon "${ICON}"
!endif

; ---------------- MUI2 页面 ----------------
!include "MUI2.nsh"
!include "WinMessages.nsh"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 ${APPNAME} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "DSHBar 是一条常驻屏幕顶部的轻量任务计时悬浮条，AI 通过 MCP 直接建任务、计时。$\r$\n$\r$\n安装到当前用户目录，无需管理员权限。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APPNAME}.exe"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 DSHBar"
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!define MUI_FINISHPAGE_SHOWREADME_TEXT "在桌面创建快捷方式"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION DSHBar_DesktopShortcut
!insertmacro MUI_PAGE_FINISH

!define MUI_UNWELCOMEPAGE_TEXT "卸载前请先在系统托盘右键 DSHBar → 退出，否则程序文件被占用、无法完全删除。"
!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; ---------------- 字符串查找（与 build/installer.nsh 同源） ----------------
Function DSHBar_FindSubstring
  Pop $R1
  Pop $R0
  Push $R2
  Push $R3
  StrLen $R2 $R1
  StrLen $R3 $R0
  StrCpy $R4 -1
  StrCmp $R2 0 fss_found0
  StrCpy $R5 0
fss_loop:
  IntOp $R6 $R5 + $R2
  IntCmp $R6 $R3 0 0 fss_notfound
  StrCpy $R4 $R0 $R2 $R5
  StrCmp $R4 $R1 fss_found
  IntOp $R5 $R5 + 1
  Goto fss_loop
fss_found0:
  StrCpy $R4 0
  Goto fss_out
fss_found:
  StrCpy $R4 $R5
  Goto fss_out
fss_notfound:
  StrCpy $R4 -1
fss_out:
  Pop $R3
  Pop $R2
  Push $R4
FunctionEnd

; ---------------- 安装段 ----------------
Section "-Application"
  SetOutPath "$INSTDIR"
  File /r "${APPDIR}\*.*"

  ; 开始菜单
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${APPNAME}.exe" "" "$INSTDIR\${APPNAME}.exe" 0
  CreateShortcut "$SMPROGRAMS\${APPNAME}\卸载 ${APPNAME}.lnk" "$INSTDIR\Uninstall ${APPNAME}.exe" "" "$INSTDIR\Uninstall ${APPNAME}.exe" 0

  ; 注册「应用和功能」卸载项
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${COMPANYNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\${APPNAME}.exe,0"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall ${APPNAME}.exe" /currentuser'
  WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall ${APPNAME}.exe" /currentuser /S'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1

  ; ---- PATH 追加 <installDir>\resources（dshbar-mcp 启动器所在处） ----
  ReadRegStr $1 HKCU "Environment" "Path"
  StrCpy $2 "$INSTDIR\resources"
  Push $1
  Push $2
  Call DSHBar_FindSubstring
  Pop $3
  StrCmp $3 -1 mcp_append
  Goto mcp_broadcast
mcp_append:
  StrCmp $1 "" mcp_empty mcp_notempty
mcp_empty:
  WriteRegStr HKCU "Environment" "Path" "$2"
  Goto mcp_broadcast
mcp_notempty:
  WriteRegStr HKCU "Environment" "Path" "$2;$1"
mcp_broadcast:
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=500

  ; 卸载器（安装时写出，编译期无需执行安装包）
  WriteUninstaller "$INSTDIR\Uninstall ${APPNAME}.exe"
SectionEnd

Function DSHBar_DesktopShortcut
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${APPNAME}.exe" "" "$INSTDIR\${APPNAME}.exe" 0
FunctionEnd

; ---------------- 卸载段 ----------------
Function un.DSHBar_FindSubstring
  Pop $R1
  Pop $R0
  Push $R2
  Push $R3
  StrLen $R2 $R1
  StrLen $R3 $R0
  StrCpy $R4 -1
  StrCmp $R2 0 un_fss_found0
  StrCpy $R5 0
un_fss_loop:
  IntOp $R6 $R5 + $R2
  IntCmp $R6 $R3 0 0 un_fss_notfound
  StrCpy $R4 $R0 $R2 $R5
  StrCmp $R4 $R1 un_fss_found
  IntOp $R5 $R5 + 1
  Goto un_fss_loop
un_fss_found0:
  StrCpy $R4 0
  Goto un_fss_out
un_fss_found:
  StrCpy $R4 $R5
  Goto un_fss_out
un_fss_notfound:
  StrCpy $R4 -1
un_fss_out:
  Pop $R3
  Pop $R2
  Push $R4
FunctionEnd

Function un.DSHBar_PathRemoveEntry
  Pop $1              ; entry
  Pop $0              ; path
  Push $2
  Push $3
  Push $4
  Push $5
  StrCpy $8 ""
  StrCpy $7 "$0;"
un_pre_loop:
  StrLen $9 $7
  StrCmp $9 0 un_pre_done
  Push $7
  Push ";"
  Call un.DSHBar_FindSubstring
  Pop $6
  StrCmp $6 -1 un_pre_done
  StrCpy $2 $7 $6
  IntOp $9 $6 + 1
  StrCpy $7 $7 "" $9
  StrCmp $2 $1 un_pre_loop
  StrCpy $8 "$8$2;"
  Goto un_pre_loop
un_pre_done:
  StrLen $9 $8
  StrCmp $9 0 un_pre_empty
  IntOp $9 $9 - 1
  StrCpy $8 $8 $9
un_pre_empty:
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Push $8
FunctionEnd

Section "Uninstall"
  ; ---- 从用户 PATH 移除我们的条目 ----
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCmp $0 "" un_mcp_path_done
  Push $0
  Push "$INSTDIR\resources"
  Call un.DSHBar_PathRemoveEntry
  Pop $1
  WriteRegStr HKCU "Environment" "Path" "$1"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=500
un_mcp_path_done:

  Delete "$DESKTOP\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\卸载 ${APPNAME}.lnk"
  RMDir "$SMPROGRAMS\${APPNAME}"

  DeleteRegKey HKCU "${UNINSTKEY}"
  RMDir /r "$INSTDIR"
SectionEnd
