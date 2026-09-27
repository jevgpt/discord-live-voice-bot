"""Is the local speech install healthy? Prints torch and CUDA, then each speech engine and whisper.

Run it with the environment's Python (the setup scripts do): .venv-chatterbox/Scripts/python on Windows,
.venv-chatterbox/bin/python elsewhere. It imports each engine that is installed, which the server itself
only does when a line is routed to it, so a broken install shows up here rather than at the first word.
Exits 1 when torch is missing, when no engine is ready, or when an installed engine fails to import.
"""
import importlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from voice_engines import ENGINE_IMPORTS, ENGINE_NAMES, module_installed  # noqa: E402

WHAT = {
    "chatterbox": "multilingual included, clones a voice",
    "freya": "Turkish, one voice",
    "pocket": "en fr de it pt es nl, clones a voice with the gated weights",
}
INSTALL = "tools/setup-chatterbox.ps1 -Engines ... (Windows) or tools/setup-voice.sh --engines ..."

try:
    import torch

    print(f"torch: {torch.__version__} | cuda: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        free, total = torch.cuda.mem_get_info()
        print(f"gpu: {torch.cuda.get_device_name(0)} ({free / 1e9:.1f} of {total / 1e9:.1f} GB free)")
except Exception as err:  # the install may not have finished yet
    print(f"ERROR torch: {err}")
    sys.exit(1)

ready = []
broken = []
for name in ENGINE_NAMES:
    module, attribute = ENGINE_IMPORTS[name]
    if not module_installed(module.split(".")[0]):
        print(f"{name}: not installed ({INSTALL})")
        continue
    try:
        getattr(importlib.import_module(module), attribute)
    except Exception as err:
        print(f"ERROR {name}: installed, but it does not import: {err}")
        broken.append(name)
        continue
    print(f"{name}: ready ({WHAT[name]})")
    ready.append(name)

if module_installed("faster_whisper"):
    print("faster-whisper: installed (the local ears)")
else:
    print("faster-whisper: not installed; the local brain needs it (pip install faster-whisper)")

if broken or not ready:
    sys.exit(1)
