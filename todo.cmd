@echo off
setlocal
pushd "%~dp0" || exit /b 1
if not exist "node_modules\.bin\electron.cmd" (
    echo Run npm ci in the extracted app folder first.
    popd
    exit /b 1
)
call npm.cmd start
set "result=%errorlevel%"
popd
exit /b %result%
