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
' Flow: wait for the shell to exit -> force-kill fallback (+ its children) ->
'       release the web port (stop whatever still holds it) -> start DSH
'       through WMI -> VERIFY it actually came up, retry with alternates, and
'       if everything fails show a message box instead of leaving the user
'       with a closed DSH and no explanation.
'
' !! KEEP THIS FILE PURE ASCII !!
'   Windows Script Host reads .vbs as ANSI unless the file has a UTF-16 BOM.
'   UTF-8 Chinese text in a string literal can swallow the closing quote and
'   the whole script fails to compile. Comments/strings must stay ASCII.
'   Chinese text for the message box is built with ChrW() codes on purpose.
' ============================================================================
Option Explicit

Dim shellPid, exePath, logPath, portNo, ticket
Dim fso, svc, sh, workDir, waited, ok, owner
Dim exeName, msgFail

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

If WScript.Arguments.Count < 4 Then
  WScript.Quit 2
End If

shellPid = CLng(WScript.Arguments(0))
exePath = WScript.Arguments(1)
logPath = WScript.Arguments(2)
portNo = CLng(WScript.Arguments(3))
' Optional 5th argument: the host's restart ticket. When one is given, the helper
' must find it fresh before it may terminate anything: a cancelled restart must
' not be executed 25 seconds later by a stray helper. That mistake cost a user
' their DSH install on 2026-10-12.
ticket = ""
If WScript.Arguments.Count >= 5 Then ticket = "" & WScript.Arguments(4)
workDir = fso.GetParentFolderName(exePath)
exeName = fso.GetFileName(exePath)

' Built with ChrW so this file stays pure ASCII.
msgFail = "DSH was closed but could not be restarted automatically." & vbCrLf & vbCrLf _
  & ChrW(68) & ChrW(83) & ChrW(72) & ChrW(32) & ChrW(24050) & ChrW(20851) & ChrW(38381) & ChrW(65292) _
  & ChrW(20294) & ChrW(33258) & ChrW(21160) & ChrW(37325) & ChrW(21551) & ChrW(22833) & ChrW(36133) _
  & ChrW(12290) & ChrW(35831) & ChrW(25163) & ChrW(21160) & ChrW(25171) & ChrW(24320) & ChrW(32) _
  & ChrW(68) & ChrW(83) & ChrW(72) & ChrW(12290)

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

Sub TerminatePid(pid, why)
  On Error Resume Next
  Err.Clear
  GetObject("winmgmts:\\.\root\cimv2:Win32_Process.Handle='" & pid & "'").Terminate()
  If Err.Number <> 0 Then
    WriteLog "terminate pid=" & pid & " failed: " & Err.Number & " " & Err.Description
  Else
    WriteLog "terminated pid=" & pid & " (" & why & ")"
  End If
  On Error GoTo 0
End Sub

Sub KillChildren(parentPid)
  Dim q, p
  On Error Resume Next
  Set q = svc.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ParentProcessId=" & parentPid)
  If IsObject(q) Then
    For Each p In q
      TerminatePid p.ProcessId, "child of shell"
    Next
  End If
  On Error GoTo 0
End Sub

' The host writes a ticket right before dispatching us and deletes it if it gives
' up. Fresh ticket = the restart is still wanted; missing or stale = do nothing.
Function TicketOk()
  Dim f
  TicketOk = True
  If ticket = "" Then Exit Function
  TicketOk = False
  On Error Resume Next
  If fso.FileExists(ticket) Then
    Set f = fso.GetFile(ticket)
    If DateDiff("s", f.DateLastModified, Now) < 180 Then TicketOk = True
  End If
  On Error GoTo 0
End Function

' How many running processes are the very exe we are about to start.
' Electron children (renderer, GPU, utility) carry --type= and are NOT a sign
' that the app came up, so they are excluded.
Function InstanceCount()
  Dim q, p
  InstanceCount = 0
  On Error Resume Next
  Set q = svc.ExecQuery("SELECT ProcessId, ExecutablePath, CommandLine FROM Win32_Process WHERE Name='" & exeName & "'")
  If IsObject(q) Then
    For Each p In q
      If StrComp(CStr(p.ExecutablePath), exePath, 1) = 0 Then
        If InStr("" & p.CommandLine, "--type=") = 0 Then InstanceCount = InstanceCount + 1
      End If
    Next
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

Function PortOwner(portNumber)
  Dim q, c
  PortOwner = 0
  If portNumber <= 0 Then Exit Function
  On Error Resume Next
  Set q = GetObject("winmgmts:\\.\root\StandardCimv2").ExecQuery( _
    "SELECT OwningProcess FROM MSFT_NetTCPConnection WHERE LocalPort=" & portNumber & " AND State=2")
  If IsObject(q) Then
    For Each c In q
      PortOwner = CLng(c.OwningProcess)
    Next
  End If
  On Error GoTo 0
End Function

' Only ever stop something that belongs to our own DSH stack: the shell exe
' itself, a node.exe runtime, or an Electron child carrying the app name.
Function IsOurStack(pid)
  Dim q, p, n
  IsOurStack = False
  If pid <= 0 Then Exit Function
  On Error Resume Next
  Set q = svc.ExecQuery("SELECT Name FROM Win32_Process WHERE ProcessId=" & pid)
  If IsObject(q) Then
    For Each p In q
      n = LCase(CStr(p.Name))
      If n = LCase(exeName) Then IsOurStack = True
      If n = "node.exe" Then IsOurStack = True
      If n = "electron.exe" Then IsOurStack = True
    Next
  End If
  On Error GoTo 0
End Function

Function LaunchViaWmi()
  Dim cls, rc, newPid, attempt
  LaunchViaWmi = False
  For attempt = 1 To 4
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
        LaunchViaWmi = True
        On Error GoTo 0
        Exit Function
      End If
    Else
      WriteLog "create attempt " & attempt & " failed: " & Err.Number & " " & Err.Description
    End If
    On Error GoTo 0
    WScript.Sleep 700
  Next
  WriteLog "WMI create gave up after 4 attempts"
End Function

Function WaitForInstance(timeoutMs)
  waited = 0
  WaitForInstance = False
  Do While waited < timeoutMs
    If InstanceCount() > 0 Then
      WaitForInstance = True
      Exit Function
    End If
    WScript.Sleep 250
    waited = waited + 250
  Loop
End Function

WriteLog "helper started: shellPid=" & shellPid & " port=" & portNo & " exe=" & exePath

If Not fso.FileExists(exePath) Then
  WriteLog "ABORT: executable not found: " & exePath
  MsgBox msgFail & vbCrLf & vbCrLf & "Missing: " & exePath, 48, "dsh-hot-restart"
  WScript.Quit 2
End If

' 1) normal path: the host half already asked the shell to close
waited = 0
Do While Alive(shellPid) And waited < 25000
  WScript.Sleep 250
  waited = waited + 250
Loop
WriteLog "shell gone after wait: " & (Not Alive(shellPid))

' 1b) cancellation check, before anything destructive happens.
'     If the host gave up on this restart it deletes the ticket; then we must NOT
'     force-terminate the shell - otherwise a cancelled restart still closes DSH
'     25 seconds later, which is exactly the bug that broke a user's install.
If Not TicketOk() Then
  WriteLog "ABORT: restart ticket missing or stale; leaving DSH untouched"
  WScript.Quit 5
End If
' Claim it: one ticket authorises exactly one restart.
On Error Resume Next
If ticket <> "" Then fso.DeleteFile ticket, True
On Error GoTo 0

' 2) fallback: the host never got to close it, or the close failed.
'    Children are stopped too: the host half holds the web port, and a leftover
'    host makes the new instance exit immediately with a bind error.
If Alive(shellPid) Then
  WriteLog "shell still alive; forcing termination from the helper"
  TerminatePid shellPid, "shell"
  KillChildren shellPid
  waited = 0
  Do While Alive(shellPid) And waited < 15000
    WScript.Sleep 250
    waited = waited + 250
  Loop
  WriteLog "shell gone after force: " & (Not Alive(shellPid))
Else
  KillChildren shellPid
End If

If Alive(shellPid) Then
  WriteLog "ABORT: shell did not exit; not starting a second instance"
  MsgBox msgFail, 48, "dsh-hot-restart"
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

' 3b) something still holds the port: it is a leftover part of our own stack
'     (usually the host half), so stop it - otherwise DSH would come up and die.
If PortBusy(portNo) Then
  owner = PortOwner(portNo)
  WriteLog "port still busy; owner pid=" & owner
  If owner > 0 And IsOurStack(owner) Then
    TerminatePid owner, "port holder"
    waited = 0
    Do While PortBusy(portNo) And waited < 10000
      WScript.Sleep 250
      waited = waited + 250
    Loop
    WriteLog "port free after stopping owner: " & (Not PortBusy(portNo))
  End If
End If

' 4) start DSH through WMI: parent is WmiPrvSE, no console is inherited
ok = LaunchViaWmi()
If ok Then WriteLog "launch issued"

' 5) verify it really came up, then fall back to other launch methods
If WaitForInstance(20000) Then
  WriteLog "new instance is up: " & InstanceCount()
  WScript.Quit 0
End If
WriteLog "not up yet; trying ShellExecute fallback"
On Error Resume Next
CreateObject("Shell.Application").ShellExecute exePath, "", workDir, "open", 1
On Error GoTo 0
If WaitForInstance(15000) Then
  WriteLog "new instance is up after ShellExecute"
  WScript.Quit 0
End If
WriteLog "not up yet; trying cmd start fallback"
On Error Resume Next
sh.Run "cmd /c start """" """ & exePath & """", 0, False
On Error GoTo 0
If WaitForInstance(15000) Then
  WriteLog "new instance is up after cmd start"
  WScript.Quit 0
End If

WriteLog "FAILED: could not start DSH automatically"
MsgBox msgFail, 48, "dsh-hot-restart"
WScript.Quit 4
