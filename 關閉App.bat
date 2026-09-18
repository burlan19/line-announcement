@echo off
chcp 65001 >nul
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 5050 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Write-Host '已關閉LINE群組公告系統伺服器。' } else { Write-Host '沒有偵測到正在執行的伺服器程序。' }"
echo.
pause