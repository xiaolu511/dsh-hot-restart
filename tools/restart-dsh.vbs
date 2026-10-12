' ============================================================================
' dsh-hot-restart :: silent restart - double-click me
' ----------------------------------------------------------------------------
' Closes and reopens the DSH desktop app with NO console/terminal window.
'
' Why not a .cmd / .ps1: those are console programs, and Windows 11 hands the
' console to Windows Terminal, which opens a visible window - and the launched
' DSH inherits it, so closing that window would kill DSH. wscript.exe is a
' GUI-subsystem program and never creates a console.
'
' Two hard lessons are baked in here:
'   1) Never look for a hard-coded exe name. Builds differ ("DeepSeek
'      Harness.exe", "DSH Desktop.exe"), so the shell is found by name pattern
'      plus "is not an Electron --type= child".
'   2) Never kill the shell before the helper has proven it is alive. On some
'      machines the dispatched helper silently does nothing, and the user would
'      just lose their DSH. We wait for the helper's first log line and abort
'      with a message box if it never appears.
'
' !! KEEP THIS FILE PURE ASCII !!
'   Windows Script Host reads .vbs as ANSI. UTF-8 non-ASCII text inside a string
'   literal can swallow the closing quote and break compilation.
' ============================================================================
Option Explicit

Dim fso, sh, svc, col, item, shellPid, exePath, helper, logPath, profileDir
Dim cls, rc, helperPid, port, waited, ok, before, sizeNow, txt, stream
Dim exeName, psHelper, psExe, psLine

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

' --check: compile-only switch for the test suite. VBScript compiles the whole
' file before executing, so this still catches syntax errors - but it never
' touches DSH. Never syntax-check this tool by simply running it!
If WScript.Arguments.Count > 0 Then
  If LCase("" & WScript.Arguments(0)) = "--check" Then WScript.Quit 0
End If

Set svc = GetObject("winmgmts:\\.\root\cimv2")

helper = fso.BuildPath(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)), "lib\relaunch.vbs")
If Not fso.FileExists(helper) Then
  MsgBox "Relaunch helper not found:" & vbCrLf & helper, 16, "DSH hot restart"
  WScript.Quit 1
End If

' --- find the desktop shell: any DSH-ish GUI process that is not a child role -
shellPid = 0
exePath = ""
exeName = ""
Set col = svc.ExecQuery("SELECT ProcessId, Name, CommandLine, ExecutablePath FROM Win32_Process WHERE Name LIKE '%dsh%' OR Name LIKE '%harness%' OR Name LIKE '%deepseek%'")
For Each item In col
  Dim cmd, nm
  cmd = "" & item.CommandLine
  nm = LCase("" & item.Name)
  If InStr(cmd, "--type=") = 0 _
     And InStr(cmd, "dsh-desktop-host") = 0 _
     And InStr(cmd, "--expose-internals") = 0 _
     And nm <> "node.exe" And nm <> "cmd.exe" And nm <> "powershell.exe" And nm <> "wscript.exe" Then
    If item.ExecutablePath <> "" Then
      shellPid = CLng(item.ProcessId)
      exePath = "" & item.ExecutablePath
      exeName = "" & item.Name
    End If
  End If
Next

If shellPid = 0 Or exePath = "" Then
  MsgBox "No DSH desktop window found." & vbCrLf & vbCrLf & _
         "If DSH is closed, just start it normally.", 48, "DSH hot restart"
  WScript.Quit 1
End If

profileDir = sh.ExpandEnvironmentStrings("%USERPROFILE%")
logPath = profileDir & "\.dsh\hot-restart\restart.log"
On Error Resume Next
fso.CreateFolder profileDir & "\.dsh\hot-restart"
On Error GoTo 0

' --- the web port belongs to the host half, a child of the shell ------------
port = 0
On Error Resume Next
Dim q, c, kidQ
Set q = GetObject("winmgmts:\\.\root\StandardCimv2").ExecQuery("SELECT OwningProcess, LocalPort FROM MSFT_NetTCPConnection WHERE State=2")
For Each c In q
  Set kidQ = svc.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & c.OwningProcess & " AND ParentProcessId=" & shellPid)
  If IsObject(kidQ) Then
    If kidQ.Count > 0 Then port = CLng(c.LocalPort)
  End If
Next
On Error GoTo 0

before = 0
On Error Resume Next
If fso.FileExists(logPath) Then before = fso.GetFile(logPath).Size
On Error GoTo 0

' --- dispatch the console-free helper through WMI (escapes the DSH job) -----
Sub Dispatch(commandLine)
  On Error Resume Next
  Err.Clear
  rc = -1
  helperPid = 0
  Set cls = GetObject("winmgmts:\\.\root\cimv2:Win32_Process")
  ' Create returns a return code and fills ByRef ProcessId (never an object).
  rc = cls.Create(commandLine, sh.ExpandEnvironmentStrings("%SystemRoot%"), Null, helperPid)
  If Err.Number <> 0 Then rc = -1
  On Error GoTo 0
End Sub

Dispatch "wscript.exe //B """ & helper & """ " & shellPid & " """ & exePath & """ """ & logPath & """ " & port

' --- the helper must prove it is alive before we end the shell --------------
ok = False
waited = 0
Do While waited < 5000
  sizeNow = 0
  On Error Resume Next
  If fso.FileExists(logPath) Then sizeNow = fso.GetFile(logPath).Size
  On Error GoTo 0
  If sizeNow > before Then
    txt = ""
    On Error Resume Next
    Set stream = fso.OpenTextFile(logPath, 1)
    txt = stream.ReadAll()
    stream.Close
    On Error GoTo 0
    If InStr(txt, "[relaunch]") > 0 Then ok = True
  End If
  If ok Then Exit Do
  WScript.Sleep 250
  waited = waited + 250
Loop

' VBS silent -> try the PowerShell helper before giving up (same order as the plugin)
If Not ok Then
  psHelper = fso.BuildPath(fso.GetParentFolderName(helper), "relaunch.ps1")
  psExe = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
  If fso.FileExists(psHelper) And fso.FileExists(psExe) Then
    psLine = """" & psExe & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psHelper & """ -ShellPid " & shellPid & " -ExePath """ & exePath & """ -LogPath """ & logPath & """ -Port " & port
    Dispatch psLine
    waited = 0
    Do While waited < 8000
      sizeNow = 0
      On Error Resume Next
      If fso.FileExists(logPath) Then sizeNow = fso.GetFile(logPath).Size
      On Error GoTo 0
      If sizeNow > before Then
        txt = ""
        On Error Resume Next
        Set stream = fso.OpenTextFile(logPath, 1)
        txt = stream.ReadAll()
        stream.Close
        On Error GoTo 0
        If InStr(txt, "[relaunch]") > 0 Then ok = True
      End If
      If ok Then Exit Do
      WScript.Sleep 250
      waited = waited + 250
    Loop
  End If
End If

If Not ok Then
  MsgBox "The relaunch helper did not start, so DSH was left running." & vbCrLf & vbCrLf & _
         "Nothing was closed. Please restart DSH from the tray icon or the Start menu.", 48, "DSH hot restart"
  WScript.Quit 3
End If

' --- helper is alive: end the old shell, the helper brings DSH back ---------
WScript.Sleep 600
On Error Resume Next
Err.Clear
GetObject("winmgmts:\\.\root\cimv2:Win32_Process.Handle='" & shellPid & "'").Terminate()
If Err.Number <> 0 Then
  MsgBox "The helper is ready, but terminating the old process failed (" & Err.Number & ")." & vbCrLf & _
         "Quit DSH manually and the helper will start a new instance.", 48, "DSH hot restart"
End If
On Error GoTo 0

WScript.Quit 0
