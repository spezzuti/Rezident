' AgentOS launcher — starts the backend hidden (no console window).
' Registered with Task Scheduler to run at logon.
Dim shell
Set shell = CreateObject("Wscript.Shell")
shell.CurrentDirectory = "C:\Users\sleve\AgenticOS\backend"
shell.Run """C:\Users\sleve\AgenticOS\backend\.venv\Scripts\uvicorn.exe"" agentos.main:app --host 0.0.0.0 --port 8734", 0, False
