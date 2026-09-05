@echo off
cd /d "%~dp0.."
start "hera web" powershell -NoExit -Command "bun dev:web"
start "hera server" powershell -NoExit -Command "bun dev:server"
start "hera agent" powershell -NoExit -Command "bun dev:agent"
