' ============================================================================
' dsh-hot-restart :: relaunch helper (console-free)
' ----------------------------------------------------------------------------
' Dispatched by the plugin host half through WMI:
'   wscript.exe //B relaunch.vbs <ShellPid> <ExePath> <LogPath> <Port>
'
' WHY wscript + VBS instead of PowerShell:
'   1) It must be created through WMI: DSH's processes live inside a Windows Job
'      object, so anything spawned as a child dies with the Electron shell. A
'      WMI-created process is owned by WmiPrvSE and survives the shell.
'   2) wscript.exe is a GUI-subsystem program: it creates NO console window.
'      powershell.exe is a console program, and Windows 11 hands consoles to
'      Windows Terminal, which opens a VISIBLE window even with
'      -WindowStyle Hidden. The relaunched DSH then inherited that console, so
'      closing the window killed DSH. That was the black window bug.
'
' Flow: wait for the shell to exit -> force-kill fallback -> wait for the port
'       to be released -> start DSH through WMI (no console inheritance).
'
' !! KEEP THIS FILE PURE ASCII !!
'   Windows Script Host reads .vbs as ANSI unless the file has a UTF-16 BOM.
'   UTF-8 Chinese text in a string literal can swallow the closing quote and
'   the whole script fails to compile. Comments/strings must stay ASCII.
' ============================================================================
Option Explicit

Dim shellPid, exePath, logPath, portNo
Dim fso, svc, sh, workDir, waited, ok

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

If WScript.Arguments.Count < 4 Then
  WScript.Quit 2
End If

shellPid = CLng(WScript.Arguments(0))
exePath = WScript.Arguments(1)
logPath = WScript.Arguments(2)
portNo = CLng(WScript.Arguments(3))
workDir = fso.GetParentFolderName(exePath)

Set svc = GetObject("winmgmts:\\.\root\cimv2")

Sub WriteLog(msg)
  Dim f
  On Error Resume Next
  If logPath = "" Then Exit Sub
  Set f = fso.OpenTextFile(logPath, 8, True)
  f.WriteLine Now & " [relaunch] " & msg
  f.Close
  On Error GoTo 0
End Sub

Function Alive(pid)
  Dim q
  Alive = False
  On Error Resume Next
  Set q = svc.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & pid)
  If IsObject(q) Then
    If q.Count > 0 Then Alive = True
  End If
  On Error GoTo 0
End Function

Function PortBusy(portNumber)
  Dim q
  PortBusy = False
  If portNumber <= 0 Then Exit Function
  On Error Resume Next
  Set q = GetObject("winmgmts:\\.\root\StandardCimv2").ExecQuery( _
    "SELECT LocalPort FROM MSFT_NetTCPConnection WHERE LocalPort=" & portNumber & " AND State=2")
  If IsObject(q) Then
    If q.Count > 0 Then PortBusy = True
  End If
  On Error GoTo 0
End Function

Function LaunchDsh()
  Dim cls, rc, newPid, attempt
  LaunchDsh = False
  For attempt = 1 To 3
    On Error Resume Next
    Err.Clear
    rc = -1
    newPid = 0
    Set cls = GetObject("winmgmts:\\.\root\cimv2:Win32_Process")
    ' NOTE: Win32_Process.Create returns a uint32 return code and fills the
    ' ByRef ProcessId - it does NOT return an object (assigning it with Set
    ' fails with "Object required", 424).
    rc = cls.Create("""" & exePath & """", workDir, Null, newPid)
    If Err.Number = 0 Then
      WriteLog "create attempt " & attempt & " rc=" & rc & " pid=" & newPid
      If rc = 0 Then
        LaunchDsh = True
        On Error GoTo 0
        Exit Function
      End If
    Else
      WriteLog "create attempt " & attempt & " failed: " & Err.Number & " " & Err.Description
    End If
    On Error GoTo 0
    WScript.Sleep 500
  Next
  ' Fallback: wscript has no console either, so a Shell.Run child still inherits none.
  On Error Resume Next
  Err.Clear
  sh.Run """" & exePath & """", 1, False
  If Err.Number = 0 Then LaunchDsh = True
  On Error GoTo 0
  WriteLog "fallback shell run used, ok=" & LaunchDsh
End Function

WriteLog "helper started: shellPid=" & shellPid & " port=" & portNo & " exe=" & exePath

If Not fso.FileExists(exePath) Then
  WriteLog "ABORT: executable not found: " & exePath
  WScript.Quit 2
End If

' 1) normal path: the host half already issued taskkill
waited = 0
Do While Alive(shellPid) And waited < 25000
  WScript.Sleep 250
  waited = waited + 250
Loop
WriteLog "shell gone after wait: " & (Not Alive(shellPid))

' 2) fallback: the host never got to kill it, or the kill failed
If Alive(shellPid) Then
  WriteLog "shell still alive; forcing termination from the helper"
  On Error Resume Next
  GetObject("winmgmts:\\.\root\cimv2:Win32_Process.Handle='" & shellPid & "'").Terminate()
  If Err.Number <> 0 Then WriteLog "force terminate failed: " & Err.Number & " " & Err.Description
  On Error GoTo 0
  waited = 0
  Do While Alive(shellPid) And waited < 15000
    WScript.Sleep 250
    waited = waited + 250
  Loop
  WriteLog "shell gone after force: " & (Not Alive(shellPid))
End If

If Alive(shellPid) Then
  WriteLog "ABORT: shell did not exit; not starting a second instance"
  WScript.Quit 3
End If

' 3) let the listening socket go, so the new instance cannot hit EADDRINUSE
WScript.Sleep 600
waited = 0
Do While PortBusy(portNo) And waited < 25000
  WScript.Sleep 250
  waited = waited + 250
Loop
WriteLog "port free: " & (Not PortBusy(portNo))

' 4) start DSH through WMI: parent is WmiPrvSE, no console is inherited
ok = LaunchDsh()
If ok Then
  WriteLog "launch issued"
  WScript.Quit 0
Else
  WriteLog "LAUNCH FAILED"
  WScript.Quit 4
End If
