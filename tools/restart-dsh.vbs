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
' !! KEEP THIS FILE PURE ASCII !!
'   Windows Script Host reads .vbs as ANSI. UTF-8 non-ASCII text inside a string
'   literal can swallow the closing quote and break compilation.
' ============================================================================
Option Explicit

Dim fso, sh, svc, col, item, shellPid, exePath, helper, logPath, profileDir
Dim cls, rc, helperPid, port

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

port = 19387
helper = fso.BuildPath(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)), "lib\relaunch.vbs")
If Not fso.FileExists(helper) Then
  MsgBox "Relaunch helper not found:" & vbCrLf & helper, 16, "DSH hot restart"
  WScript.Quit 1
End If

Set svc = GetObject("winmgmts:\\.\root\cimv2")
Set col = svc.ExecQuery("SELECT ProcessId, CommandLine, ExecutablePath FROM Win32_Process WHERE Name='DeepSeek Harness.exe'")
shellPid = 0
exePath = ""
For Each item In col
  If InStr(item.CommandLine, "--type=") = 0 _
     And InStr(item.CommandLine, "dsh-desktop-host") = 0 _
     And InStr(item.CommandLine, "--expose-internals") = 0 Then
    shellPid = CLng(item.ProcessId)
    exePath = item.ExecutablePath
  End If
Next

If shellPid = 0 Or exePath = "" Then
  MsgBox "The DSH desktop shell (DeepSeek Harness.exe) is not running." & vbCrLf & vbCrLf & _
         "Just start DSH normally.", 48, "DSH hot restart"
  WScript.Quit 1
End If

profileDir = sh.ExpandEnvironmentStrings("%USERPROFILE%")
logPath = profileDir & "\.dsh\hot-restart\restart.log"
On Error Resume Next
fso.CreateFolder profileDir & "\.dsh\hot-restart"
On Error GoTo 0

' 1) dispatch the console-free helper through WMI (escapes the DSH job object)
On Error Resume Next
Err.Clear
rc = -1
helperPid = 0
Set cls = GetObject("winmgmts:\\.\root\cimv2:Win32_Process")
' Create returns a return code and fills ByRef ProcessId (never an object).
rc = cls.Create("wscript.exe //B """ & helper & """ " & shellPid & " """ & exePath & """ """ & logPath & """ " & port, _
               sh.ExpandEnvironmentStrings("%SystemRoot%"), Null, helperPid)
If Err.Number <> 0 Then
  MsgBox "Could not dispatch the relaunch helper: " & Err.Number & " " & Err.Description, 16, "DSH hot restart"
  WScript.Quit 2
End If
If rc <> 0 Then
  MsgBox "Could not dispatch the relaunch helper (Win32_Process.Create returned " & rc & ").", 16, "DSH hot restart"
  WScript.Quit 2
End If

' 2) end the old shell; the helper brings DSH back once it is gone
WScript.Sleep 600
On Error Resume Next
Err.Clear
GetObject("winmgmts:\\.\root\cimv2:Win32_Process.Handle='" & shellPid & "'").Terminate()
If Err.Number <> 0 Then
  MsgBox "Helper is ready, but terminating the old process failed (" & Err.Number & ")." & vbCrLf & _
         "Quit DSH manually and the helper will start the new instance.", 48, "DSH hot restart"
End If
On Error GoTo 0

WScript.Quit 0
