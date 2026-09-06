@echo off
chcp 65001 >nul
cd /d %~dp0
rem Moonrabbit - zero-dependency multi-character RP chat UI
rem Auto-picks a free port starting from 3081 (see start.js)
node start.js
pause
