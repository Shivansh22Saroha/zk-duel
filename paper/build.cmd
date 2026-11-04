@echo off
rem Builds paper\main.pdf with tectonic (https://tectonic-typesetting.github.io). The first run downloads
rem the TeX bundle. Regenerate figures first with: python paper\figures\make_figures.py
cd /d "%~dp0"
if not exist build mkdir build
tectonic -X compile main.tex --keep-logs --keep-intermediates --outdir build || exit /b 1
copy /y build\main.pdf main.pdf >nul
echo Built paper\main.pdf
