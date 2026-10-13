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

' Environment snapshot handed to us by the host: we were dispatched through WMI, so
' our own environment is WmiPrvSE's, not the user's. Load it before launching DSH.
LoadRelaunchEnv

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

' Environment snapshot from the host: UTF-16LE, one NAME=VALUE per line, sitting next
' to our log file. Loading it is what lets a directly-launched DSH inherit the user's
' real environment (DSH_HOME, proxies, PATH, ...) instead of WmiPrvSE's.
Sub LoadRelaunchEnv()
  Dim envFile, f, line, eq, name, value, loaded
  loaded = 0
  envFile = fso.BuildPath(fso.GetParentFolderName(logPath), "relaunch-env.txt")
  On Error Resume Next
  If Not fso.FileExists(envFile) Then
    WriteLog "env snapshot not found: " & envFile
    Exit Sub
  End If
  Set f = fso.OpenTextFile(envFile, 1, False, -1)
  Do While Not f.AtEndOfStream
    line = f.ReadLine
    eq = InStr(line, "=")
    If eq > 1 Then
      name = Left(line, eq - 1)
      value = Mid(line, eq + 1)
      sh.Environment("PROCESS")(name) = value
      loaded = loaded + 1
    End If
  Loop
  f.Close
  On Error GoTo 0
  WriteLog "env snapshot loaded: " & loaded & " vars"
End Sub

' The exact command line to bring DSH back.
' It reuses **the arguments the shell was actually started with** - taken from WMI,
' not re-invented. Without this, flags like --no-sandbox or a custom --user-data-dir
' silently disappear on every restart (three other restart plugins do this; we did not).
' Only the executable token is replaced; the rest is passed through verbatim, so no
' re-quoting is involved.
Function RelaunchCommand()
  Dim q, p, cmd, rest, i, ch, started
  RelaunchCommand = """" & exePath & """"
  cmd = ""
  On Error Resume Next
  Set q = svc.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE ProcessId=" & shellPid)
  If IsObject(q) Then
    For Each p In q
      cmd = "" & p.CommandLine
    Next
  End If
  On Error GoTo 0
  cmd = Trim(cmd)
  If cmd = "" Then Exit Function
  ' strip the first token: quoted ("...exe") or bare up to the first space
  rest = ""
  If Left(cmd, 1) = """" Then
    started = False
    For i = 2 To Len(cmd)
      ch = Mid(cmd, i, 1)
      If ch = """" Then
        rest = Trim(Mid(cmd, i + 1))
        started = True
        Exit For
      End If
    Next
    If Not started Then rest = ""
  Else
    For i = 1 To Len(cmd)
      ch = Mid(cmd, i, 1)
      If ch = " " Then
        rest = Trim(Mid(cmd, i + 1))
        Exit For
      End If
    Next
  End If
  If rest <> "" Then RelaunchCommand = """" & exePath & """ " & rest
End Function

' Start DSH from this process: no console window (wscript has none) and the
' environment snapshot we loaded is inherited by the child.
Function LaunchDirect()
  Dim cmd
  LaunchDirect = False
  cmd = RelaunchCommand()
  WriteLog "direct launch: " & cmd
  On Error Resume Next
  sh.CurrentDirectory = workDir
  sh.Run cmd, 0, False
  If Err.Number = 0 Then LaunchDirect = True
  If Err.Number <> 0 Then WriteLog "direct launch failed: " & Err.Number & " " & Err.Description
  On Error GoTo 0
End Function

' NOTE about the window (measured 2026-10-13): window-watch2.log said "it comes up by
' itself, visible and foreground" - that was WRONG, an instrument bug: it looked for the
' window through Process.MainWindowHandle, which is 0 for a window that has never been
' shown, so it could only ever see the moment the user's tray click made the window
' visible. window-watch3.log fixed that by enumerating all top-level windows (hidden ones
' included) and shows what really happens:
'
'   13:17:33  direct launch
'   13:17:34  hwnd=722472 HIDDEN class=Chrome_WidgetWin_1   <- window exists, hidden
'   13:17:45  still HIDDEN
'   13:17:56  visible                                        <- only after a tray click
'
' So the shell creates its main window about a second after launch and keeps it hidden.
' ShowMainWindow (below, calling show-window.ps1) shows it right after the launch.

' Show the DSH main window once its page is painted.
' Showing a hidden window needs no foreground rights, so a background process can do it.
' Fire and forget: if it is blocked (antivirus, policy) the restart is unaffected and the
' user can still reach the window through the tray.
Sub ShowMainWindow()
  Dim script, psExe, cmd, startup, proc, showPid, rc
  On Error Resume Next
  script = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "show-window.ps1")
  If Not fso.FileExists(script) Then
    WriteLog "show skipped: " & script & " not found"
    Exit Sub
  End If
  psExe = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
  cmd = """" & psExe & """ -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """"
  ' Launch through WMI with ShowWindow = 0. Two reasons:
  '   1. a console program started with sh.Run can flash a white console window for a
  '      moment, and the user reads that as a bug (they reported exactly that);
  '   2. a WMI-created process is outside DSH's job, so it survives whatever happens next.
  Set startup = svc.Get("Win32_ProcessStartup").SpawnInstance_()
  startup.ShowWindow = 0
  Set proc = svc.Get("Win32_Process")
  showPid = 0
  rc = proc.Create(cmd, workDir, startup, showPid)
  If Err.Number <> 0 Then
    WriteLog "show dispatch failed: " & Err.Number & " " & Err.Description
  Else
    WriteLog "show window dispatched rc=" & rc & " pid=" & showPid
  End If
  On Error GoTo 0
End Sub

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
    rc = cls.Create(RelaunchCommand(), workDir, Null, newPid)
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

' 4) launch DSH.
'    Order matters: try a **direct run from this wscript process** first.
'    wscript has no console, and it carries the environment snapshot the host handed
'    us - so the new DSH inherits the user's real environment (DSH_HOME, proxies,
'    PATH, ...) instead of WmiPrvSE's.
'    WMI is kept as the fallback: it is how DSH used to be started here, and it still
'    works when the direct run is blocked.



ok = LaunchDirect()
If ok Then WriteLog "launch issued (direct)"
' Show the real window only once its page is painted (show-window.ps1 waits for the real
' title). Fired here, in parallel with the checks below.
If ok Then ShowMainWindow
If Not WaitForInstance(20000) Then
  WriteLog "direct launch did not come up; trying WMI"
  ok = LaunchViaWmi()
  If ok Then WriteLog "launch issued (wmi)"
  If ok Then ShowMainWindow
End If

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
