; installers/windows/installer.nsi
; NSIS script for the obs-relay-control Windows installer.
;
; Build with:   makensis installer.nsi   (from the windows/ directory)
; Or use:       installers\windows\build-installer.bat
;
; Requires: NSIS 3.x  (https://nsis.sourceforge.io/Download)
; Input files expected next to this script after cmake --install:
;   staging\obs-plugins\64bit\obs-relay-control.dll
;   staging\data\obs-plugins\obs-relay-control\...

Unicode True
SetCompressor /SOLID lzma

; ── Metadata ──────────────────────────────────────────────────────────────────
!define PLUGIN_NAME    "obs-relay-control"
!define DISPLAY_NAME   "Relay Control for OBS"
!define PLUGIN_VERSION "1.0.0"
!define PUBLISHER      "Relay Control"
!define UNINST_REG     "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PLUGIN_NAME}"
!define OBS_REG_KEY    "SOFTWARE\OBS Studio"

Name            "${DISPLAY_NAME} ${PLUGIN_VERSION}"
OutFile         "..\..\${PLUGIN_NAME}-${PLUGIN_VERSION}-Windows-x64.exe"
RequestExecutionLevel admin
InstallDir      "$PROGRAMFILES64\obs-studio"

; ── Version info block (shows in Properties → Details) ────────────────────────
VIProductVersion "${PLUGIN_VERSION}.0"
VIAddVersionKey "ProductName"      "${DISPLAY_NAME}"
VIAddVersionKey "ProductVersion"   "${PLUGIN_VERSION}"
VIAddVersionKey "CompanyName"      "${PUBLISHER}"
VIAddVersionKey "FileDescription"  "OBS Plugin Installer"
VIAddVersionKey "FileVersion"      "${PLUGIN_VERSION}"
VIAddVersionKey "LegalCopyright"   "© ${PUBLISHER}"

; ── Detect OBS install path from registry ─────────────────────────────────────
; OBS 28+ writes InstallPath under HKLM\SOFTWARE\OBS Studio (64-bit key).
; Fall back to the default Program Files location if the key is absent.
Function .onInit
    SetRegView 64
    ReadRegStr $INSTDIR HKLM "${OBS_REG_KEY}" "InstallPath"
    StrCmp $INSTDIR "" notfound done
    notfound:
        StrCpy $INSTDIR "$PROGRAMFILES64\obs-studio"
    done:
FunctionEnd

; ── Pages ─────────────────────────────────────────────────────────────────────
!include "MUI2.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON   "..\..\data\obs-relay-control.ico"   ; optional — remove if no icon yet
!define MUI_UNICON "..\..\data\obs-relay-control.ico"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ── Install section ───────────────────────────────────────────────────────────
Section "Plugin" SecPlugin
    SectionIn RO  ; required, cannot be deselected

    ; ── Plugin DLL ────────────────────────────────────────────────────────────
    SetOutPath "$INSTDIR\obs-plugins\64bit"
    File "staging\obs-plugins\64bit\obs-relay-control.dll"

    ; ── Locale / data ─────────────────────────────────────────────────────────
    SetOutPath "$INSTDIR\data\obs-plugins\obs-relay-control"
    File /r "staging\data\obs-plugins\obs-relay-control\*"

    ; ── Uninstaller ───────────────────────────────────────────────────────────
    WriteUninstaller "$INSTDIR\data\obs-plugins\obs-relay-control\uninstall.exe"

    ; ── Add/Remove Programs entry ─────────────────────────────────────────────
    WriteRegStr   HKLM "${UNINST_REG}" "DisplayName"     "${DISPLAY_NAME}"
    WriteRegStr   HKLM "${UNINST_REG}" "DisplayVersion"  "${PLUGIN_VERSION}"
    WriteRegStr   HKLM "${UNINST_REG}" "Publisher"       "${PUBLISHER}"
    WriteRegStr   HKLM "${UNINST_REG}" "InstallLocation" "$INSTDIR"
    WriteRegStr   HKLM "${UNINST_REG}" "UninstallString" \
        '"$INSTDIR\data\obs-plugins\obs-relay-control\uninstall.exe"'
    WriteRegDWORD HKLM "${UNINST_REG}" "NoModify"        1
    WriteRegDWORD HKLM "${UNINST_REG}" "NoRepair"        1
SectionEnd

; ── Uninstall section ─────────────────────────────────────────────────────────
Section "Uninstall"
    Delete "$INSTDIR\obs-plugins\64bit\obs-relay-control.dll"
    RMDir /r "$INSTDIR\data\obs-plugins\obs-relay-control"
    DeleteRegKey HKLM "${UNINST_REG}"
SectionEnd
