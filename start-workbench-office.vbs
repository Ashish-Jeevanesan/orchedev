' start-workbench-office.vbs
' Double-click launcher for OrcheDev (Agent Workbench) -- OFFICE LAPTOP copy.
'
' Functionally identical to start-workbench.vbs (this file is self-locating: it always
' runs "npm start" against the folder it lives in, no hardcoded path), kept as a separate
' file purely so the personal-laptop and office-laptop launchers are distinguishable at a
' glance in the repo / on disk. No port is hardcoded -- the server binds to 127.0.0.1 on an
' OS-assigned free port (see server/launcher.js), so running this alongside the personal
' copy never collides on a port.
'
' If node_modules is missing (first run on a fresh checkout) it runs "npm install" first.
'
' Note: some corporate/office machines block Windows Script Host (.vbs) execution via
' Group Policy or endpoint security. If double-clicking this does nothing and there's no
' error, that's the likely cause -- ask IT to allow wscript.exe for this file/folder, or
' fall back to running "npm start" directly from a terminal in this folder.

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
