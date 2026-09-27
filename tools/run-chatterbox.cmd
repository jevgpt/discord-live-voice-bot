@echo off
rem Local voice server: Chatterbox, FreyaTTS, Pocket TTS and whisper (uses the venv python). Device is
rem auto-detected (cuda if available); each engine goes on the GPU only if its VRAM fits, else the CPU.
rem Usage: tools\run-chatterbox.cmd [extra args]   (e.g. --device cpu, --port 8021, --stt medium,
rem        --engines freya,pocket, --tts-engine freya, --preload tr)
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
if not exist "%~dp0..\.venv-chatterbox\Scripts\python.exe" (
	echo No virtual environment yet. Run the setup first: powershell -NoProfile -ExecutionPolicy Bypass -File tools\setup-chatterbox.ps1
	pause
	exit /b 1
)
"%~dp0..\.venv-chatterbox\Scripts\python.exe" "%~dp0chatterbox_server.py" --port 8020 --model multilingual --stt small %*
if errorlevel 1 (
	echo.
	echo The server exited with an error (exit code %errorlevel%). Read the message above; not enough memory/disk is the most common cause.
	pause
)
