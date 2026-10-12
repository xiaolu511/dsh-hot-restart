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

Dim shellPid, exePath, logPath, portNo, ticket, created
Dim fso, svc, sh, workDir, waited, ok, owner, rp
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
' Optional 7th argument: when the shell was created (WMI datetime). Windows reuses
' PID values, so this is how we make sure the process we are about to stop really
' is the shell we were asked to restart, and not some unrelated program.
created = ""
If WScript.Arguments.Count >= 7 Then created = "" & WScript.Arguments(6)
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

' Windows reuses PID values. Before stopping anything we check that the process
' still is what we think it is: same executable as the shell, and - when the host
' told us - the same creation time. Otherwise we leave it alone and say so.
Function Digits(text)
  Dim i, ch, out
  out = ""
  For i = 1 To Len(text)
    ch = Mid(text, i, 1)
    If ch >= "0" And ch <= "9" Then out = out & ch
  Next
  Digits = out
End Function

Function Identified(pid)
  Dim q, p, wantCreated, gotCreated
  Identified = False
  If pid <= 0 Then Exit Function
  On Error Resume Next
  Set q = svc.ExecQuery("SELECT ExecutablePath, CreationDate FROM Win32_Process WHERE ProcessId=" & pid)
  If IsObject(q) Then
    For Each p In q
      If StrComp(CStr(p.ExecutablePath), exePath, 1) <> 0 Then
        WriteLog "identity check failed for pid=" & pid & ": exe is " & CStr(p.ExecutablePath)
        Exit Function
      End If
      If created <> "" Then
        wantCreated = Left(Digits(created), 14)
        gotCreated = Left(Digits(CStr(p.CreationDate)), 14)
        If wantCreated <> "" And gotCreated <> "" And wantCreated <> gotCreated Then
          WriteLog "identity check failed for pid=" & pid & ": created " & gotCreated & " but expected " & wantCreated
          Exit Function
        End If
      End If
      Identified = True
    Next
  End If
  On Error GoTo 0
End Function

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

' When the relaunch fails there is nobody left to ask for help: DSH is gone and
' the user just sees nothing. So the helper itself starts the self check, which
' writes a report to the Desktop and opens it in Notepad.
Sub RunDiagnostics()
  Dim script, psExe
  On Error Resume Next
  script = fso.BuildPath(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)), "tools\diagnose.ps1")
  If Not fso.FileExists(script) Then
    WriteLog "diagnostics skipped: " & script & " not found"
    Exit Sub
  End If
  psExe = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
  If Not fso.FileExists(psExe) Then
    WriteLog "diagnostics skipped: powershell.exe not found"
    Exit Sub
  End If
  WriteLog "starting diagnostics: " & script
  sh.Run """" & psExe & """ -NoProfile -ExecutionPolicy Bypass -File """ & script & """", 1, False
  If Err.Number <> 0 Then WriteLog "diagnostics launch failed: " & Err.Number & " " & Err.Description
  On Error GoTo 0
End Sub

' The self check writes the report path into last-report.txt next to our log.
' Wait for it so the message box can name the exact file instead of saying
' "look on your Desktop somewhere".
Function ReportPath(timeoutMs)
  Dim pointer, f, stream, waited2
  ReportPath = ""
  On Error Resume Next
  pointer = fso.BuildPath(fso.GetParentFolderName(logPath), "last-report.txt")
  waited2 = 0
  Do While waited2 < timeoutMs
    If fso.FileExists(pointer) Then
      Set f = fso.GetFile(pointer)
      If DateDiff("s", f.DateLastModified, Now) < 600 Then
        Set stream = fso.OpenTextFile(pointer, 1)
        ReportPath = Trim(stream.ReadAll())
        stream.Close
      End If
    End If
    If ReportPath <> "" Then Exit Function
    WScript.Sleep 1000
    waited2 = waited2 + 1000
  Loop
  On Error GoTo 0
End Function

Sub ReportAndTell()
  RunDiagnostics
  rp = ReportPath(60000)
  If rp = "" Then rp = "(report is being written to the Desktop)"
  MsgBox msgFail & vbCrLf & vbCrLf & "Report: " & rp, 48, "dsh-hot-restart"
End Sub

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
  ' Log only, no MsgBox: with the host watching for "helper ready" this abort is
  ' reported to the user by the host itself, and a modal box here would just hang
  ' around. A mangled exe path (non-ASCII install folder) lands exactly here.
  WriteLog "ABORT: executable not found: " & exePath
  WScript.Quit 2
End If

' 0) cancellation check, before the host is allowed to touch anything.
'    If the host gave up on this restart it deletes the ticket; then we must NOT
'    force-terminate the shell - otherwise a cancelled restart still closes DSH
'    25 seconds later, which is exactly the bug that broke a user's install.
If Not TicketOk() Then
  WriteLog "ABORT: restart ticket missing or stale; leaving DSH untouched"
  WScript.Quit 5
End If
' Claim it: one ticket authorises exactly one restart.
On Error Resume Next
If ticket <> "" Then fso.DeleteFile ticket, True
On Error GoTo 0

' 0b) We validated the exe, the ticket and the pid: this is the handshake line the
'     host waits for before it closes DSH. If the host does not see it, it abandons
'     the restart and leaves DSH running - that is what keeps "closed but never
'     came back" from ever happening again.
WriteLog "helper ready: shellPid=" & shellPid & " port=" & portNo

' 1) normal path: the host half already asked the shell to close.
'    The host tries WM_CLOSE for a second and then force-kills, so 10 seconds of
'    patience here is plenty.
waited = 0
Do While Alive(shellPid) And waited < 10000
  WScript.Sleep 250
  waited = waited + 250
Loop
WriteLog "shell gone after wait: " & (Not Alive(shellPid))

' 2) fallback: the host never got to close it, or the close failed.
'    Children are stopped too: the host half holds the web port, and a leftover
'    host makes the new instance exit immediately with a bind error.
'    Identity is checked first: if the PID has been reused by something else in the
'    meantime, this "still alive" reading is about an unrelated process.
If Alive(shellPid) Then
  If Not Identified(shellPid) Then
    WriteLog "ABORT: pid=" & shellPid & " is not the shell we were asked to restart; leaving it alone"
    WScript.Quit 7
  End If
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
  ' It came up - but does it stay up? An instance that dies right after start is
  ' exactly the "DSH closed and never came back" case users hit.
  WScript.Sleep 12000
  If InstanceCount() > 0 Then
    WriteLog "instance still alive after 12s"
    WScript.Quit 0
  End If
  WriteLog "instance disappeared within 12s of starting"
  ReportAndTell
  WScript.Quit 6
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
ReportAndTell
WScript.Quit 4
