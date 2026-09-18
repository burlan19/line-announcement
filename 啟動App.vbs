Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
folder = fso.GetParentFolderName(WScript.ScriptFullName)

shell.CurrentDirectory = folder
shell.Run "cmd /c node server.js", 0, False

WScript.Sleep 1000
shell.Run "http://localhost:5050"