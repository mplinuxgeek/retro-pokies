@echo off
rem Starts the desktop player with node.exe next to this folder in a packaged build, else the node on PATH.
rem usage: retro-pokies [ROM folder | ROM zip]
set "here=%~dp0.."
if exist "%here%\node\node.exe" ("%here%\node\node.exe" "%here%\src\main.js" %*) else (node "%here%\src\main.js" %*)
