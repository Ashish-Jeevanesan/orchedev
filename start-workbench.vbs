' start-workbench.vbs
' Double-click launcher for OrcheDev (Agent Workbench).
'
' Self-locating: always runs "npm start" against the folder this .vbs file lives in,
' so the SAME file can be copied as-is to any machine/checkout (this device, the other
' device, a future clone) without editing a path. No port is hardcoded -- the server
' binds to 127.0.0.1 on an OS-assigned free port (see server/launcher.js), so running
' this on multiple machines (or multiple times on one machine) never collides on a port.
'
' If node_modules is missing (first run on a fresh checkout) it runs "npm install" first.

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

quotedDir = Chr(34) & scriptDir & Chr(34)

If Not fso.FolderExists(scriptDir & "\node_modules") Then
  cmd = "cmd /c cd /d " & quotedDir & " && npm install && npm start"
Else
  cmd = "cmd /c cd /d " & quotedDir & " && npm start"
End If

' 0 = hidden window, False = don't wait for it to exit (keeps the server running
' after this script finishes; npm start's own launcher.js owns window/lifecycle)
shell.Run cmd, 0, False
