; ============================================================================
; DSHBar - standalone copy of the uninstall-time PATH cleanup (NSIS)
;
; electron-builder loads exactly ONE custom script through `nsis.include`
; (set to build/installer.nsh in package.json), and that file contains BOTH
; the install and the uninstall macros because they share two helper functions.
; This file is a reviewable, self-contained mirror of just the uninstall half,
; kept in sync with the `customUnInstall` macro + helpers in build/installer.nsh.
;
; If you ever want to split the two macros across two files, move these helpers
; and `customUnInstall` into this file and add:
;     !include "uninstaller.nsh"
; as the first line of build/installer.nsh (NSIS resolves relative includes
; against the including file's directory), then point `nsis.include` at
; build/installer.nsh. The two files below are the pieces to move.
; ============================================================================

; --- helpers (identical to the ones in build/installer.nsh) -----------------

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

Function DSHBar_PathRemoveEntry
  Pop $1
  Pop $0
  Push $2
  Push $3
  Push $4
  Push $5
  StrCpy $8 ""
  StrCpy $7 "$0;"
pre_loop:
  StrLen $9 $7
  StrCmp $9 0 pre_done
  Push $7
  Push ";"
  Call DSHBar_FindSubstring
  Pop $6
  StrCmp $6 -1 pre_done
  StrCpy $2 $7 $6
  IntOp $9 $6 + 1
  StrCpy $7 $7 "" $9
  StrCmp $2 $1 pre_loop
  StrCpy $8 "$8$2;"
  Goto pre_loop
pre_done:
  StrLen $9 $8
  StrCmp $9 0 pre_empty
  IntOp $9 $9 - 1
  StrCpy $8 $8 $9
pre_empty:
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Push $8
FunctionEnd

; --- uninstall hook ---------------------------------------------------------

!macro customUnInstall
  Delete "$INSTDIR\resources\dshbar-mcp.cmd"

  ReadRegStr $0 HKCU "Environment" "Path"
  StrCmp $0 "" mcp_un_path_done
  Push $0
  Push "$INSTDIR\resources"
  Call DSHBar_PathRemoveEntry
  Pop $1
  WriteRegStr HKCU "Environment" "Path" "$1"
  SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=500
mcp_un_path_done:
!macroend