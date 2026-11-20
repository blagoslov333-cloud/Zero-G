@echo off
setlocal
set "PY_EXE=C:\Users\blagoslov333\AppData\Local\Programs\Python\Python312\python.exe"
if not exist "%PY_EXE%" set "PY_EXE=python.exe"
"%PY_EXE%" -I -S "%~dp0..\hooks\shim.py" %*
exit /b %ERRORLEVEL%
