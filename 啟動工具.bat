@echo off
chcp 65001 >nul
pushd "%~dp0"
start "" http://localhost:5050
node server.js
popd
pause