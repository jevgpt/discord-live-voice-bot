"""Chatterbox local TTS server -- binds to 127.0.0.1 only.

The bot pulls raw PCM from this server and pushes it straight into Discord (no cloud TTS).

Loopback is reachable from every web page the machine's browser opens, so a request is refused when:
  - its Host header does not name the loopback address the server is bound to (DNS rebinding; the port
    is not compared, so a forwarded port such as ssh -L 9000:127.0.0.1:8020 still works),
  - it carries an Origin header (browsers send one; the bot never does),
  - a JSON endpoint is sent anything but application/json (a form or text/plain post needs no preflight),
  - a token is set (--token or CHATTERBOX_TOKEN) and the X-Chatterbox-Token header does not match it.
The bot starts the server with a fresh random token each time; one started by hand takes LOCAL_TTS_TOKEN.

Setup (once):
    python -m venv .venv-chatterbox
    .venv-chatterbox/Scripts/python -m pip install chatterbox-tts
    (for the GPU) .venv-chatterbox/Scripts/python -m pip install --force-reinstall torch torchaudio --index-url https://download.pytorch.org/whl/cu124

Running:
    .venv-chatterbox/Scripts/python tools/chatterbox_server.py --port 8020 --model multilingual --device cuda

Endpoints:
    GET  /health   -> {"ok":true,"model":"multilingual","sr":24000,"device":"cuda","voice":...,"stt":"small"|null}
    POST /stt      -> body: raw int16 PCM mono (x-sample-rate header, 16000 by default), ?language=tr (empty = auto-detect)
                      response: {"ok":true,"text":"...","language":"tr","duration":2.4}   (switched on with --stt <model>)
    POST /tts      -> {"text":"...","voice_ref":"C:/path/ref.wav","language_id":"tr","exaggeration":0.5,"cfg_weight":0.5}
                      response: raw int16 PCM (mono), x-sample-rate header
    POST /voice    -> {"voice_ref":"C:/path/ref.wav"}  (sets the default reference voice; an existing audio file)
    POST /shutdown -> shuts the server down

Note: the model is downloaded from Hugging Face on the first run; every generated audio carries a Perth watermark.
"""

import argparse
import contextlib
import ctypes
import faulthandler
import hmac
import inspect
import ipaddress
import json
import os
import re
import site
import struct
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

STATE = {
    "model": None,
    "kind": "multilingual",
    "sr": 24000,
    "device": "cpu",
    "voice_ref": None,
    "lock": threading.Lock(),
    "stop": threading.Event(),  # /shutdown ends the main loop too (so no zombie process is left behind)
    "stt": None,  # faster-whisper model (switched on with --stt)
    "stt_name": None,
    "stt_lock": threading.Lock(),
}

MAX_BODY_BYTES = 256 * 1024
MAX_STT_BYTES = 20 * 1024 * 1024  # ~10 min of 16 kHz int16

TOKEN_HEADER = "X-Chatterbox-Token"
LOOPBACK_NAMES = {"localhost", "127.0.0.1", "::1"}
# What a reference voice can be: the model reads it as audio, so nothing else on the disk is accepted.
AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac"}


def is_loopback(host: str) -> bool:
    name = (host or "").strip().strip("[]").lower()
    if name == "localhost":
        return True
    try:
        return ipaddress.ip_address(name).is_loopback
    except ValueError:
        return False


def allowed_host_names(host: str):
    """The names a Host header may carry when the server is bound to loopback; None when it is bound
    elsewhere, where the names it is reached by cannot be known and the token is what guards it."""
    if not is_loopback(host):
        return None
    return LOOPBACK_NAMES | {(host or "").strip().strip("[]").lower()}


def split_host_header(value):
    """'127.0.0.1:8020' -> ('127.0.0.1', 8020), '[::1]:8020' -> ('::1', 8020), 'localhost' -> ('localhost', None)."""
    match = re.fullmatch(r"(\[[^\]]+\]|[^:\[\]/\s]+)(?::(\d{1,5}))?", (value or "").strip().lower())
    if not match:
        return None, None
    return match.group(1).strip("[]"), int(match.group(2)) if match.group(2) else None


def request_refusal(headers, allowed_hosts, token):
    """Why a request is refused, or None when it may go on. `token` is bytes (or None: no token set).

    Only the name in the Host header is compared, never its port. A rebinding page cannot make the
    browser send a loopback name, so the name alone defeats it; the port, on the other hand, is whatever
    the client connected to, and through a forwarded port (ssh -L 9000:127.0.0.1:8020) that is not ours.
    """
    if allowed_hosts is not None:
        name, _port = split_host_header(headers.get("host"))
        if name is None or name not in allowed_hosts:
            return "host not allowed"
    if headers.get("origin") is not None:
        return "requests from a web page are not accepted"
    if token is not None:
        given = (headers.get(TOKEN_HEADER) or "").encode("utf-8", "replace")
        if not hmac.compare_digest(given, token):
            return "missing or wrong token"
    return None


def checked_voice_ref(value):
    """A reference voice from a request: None for none, else the resolved path of an existing audio file.
    Anything else raises ValueError, so a request cannot point the model at an arbitrary file."""
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValueError("voice_ref must be a file path")
    path = os.path.realpath(value)
    if os.path.splitext(path)[1].lower() not in AUDIO_EXTENSIONS or not os.path.isfile(path):
        raise ValueError(f"voice_ref must be an existing audio file ({', '.join(sorted(AUDIO_EXTENSIONS))})")
    return path


def _prepare_cuda_dlls():
    """On CUDA, ctranslate2 (faster-whisper) looks for the cuBLAS/cuDNN DLLs; pip's nvidia-* packages
    and the torch/lib folder are added to the DLL search path (Windows)."""
    if os.name != "nt":
        return
    candidates = []
    for sp in site.getsitepackages() + [site.getusersitepackages()]:
        for sub in ("cublas", "cudnn", "cuda_runtime"):
            for leaf in ("bin", "lib"):
                candidates.append(os.path.join(sp, "nvidia", sub, leaf))
    try:
        import torch

        candidates.append(os.path.join(os.path.dirname(torch.__file__), "lib"))
    except Exception:
        pass
    for path in candidates:
        if os.path.isdir(path):
            try:
                os.add_dll_directory(path)
            except (OSError, AttributeError):
                pass
            os.environ["PATH"] = path + os.pathsep + os.environ.get("PATH", "")


def load_stt(name: str, device: str):
    """Loads the faster-whisper model (float16 on CUDA, int8 on the CPU). When the CUDA libraries are
    missing it falls back to the CPU with a warning; a transcription is tried right here as well (a
    library error can surface only then)."""
    from faster_whisper import WhisperModel

    if device == "cuda":
        _prepare_cuda_dlls()
        try:
            model = WhisperModel(name, device="cuda", compute_type="float16")
            # Warm-up + library check: 0.5 s of silence
            list(model.transcribe(np.zeros(8000, dtype=np.float32), beam_size=1)[0])
            return model
        except Exception as err:
            print(
                f"[chatterbox] STT could not start on CUDA ({str(err).splitlines()[-1][:120]}); continuing with CPU int8. "
                "For the GPU: pip install nvidia-cublas-cu12 nvidia-cudnn-cu12 (the setup script does this).",
                flush=True,
            )
    model = WhisperModel(name, device="cpu", compute_type="int8")
    if name not in ("tiny", "base"):
        print(f"[chatterbox] STT '{name}' can be slow on the CPU; --stt base is recommended for conversation.", flush=True)
    return model


def transcribe(pcm_bytes: bytes, sample_rate: int, language, prompt=None):
    """Raw int16 PCM -> text. Resamples linearly when the rate is not 16 kHz."""
    audio = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0
    if sample_rate != 16000 and len(audio) > 1:
        target = int(round(len(audio) * 16000 / sample_rate))
        audio = np.interp(np.linspace(0, len(audio) - 1, target), np.arange(len(audio)), audio).astype(np.float32)
    with STATE["stt_lock"]:
        segments, info = STATE["stt"].transcribe(
            audio,
            language=language or None,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
            initial_prompt=prompt or None,  # names (e.g. "Aria, Deniz") come out spelled more accurately
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
    return text, getattr(info, "language", language), float(getattr(info, "duration", len(audio) / 16000.0))


def _from_pretrained(cls, device: str, **extra):
    """Calls from_pretrained independently of the version: unsupported extra parameters are filtered out
    (e.g. older versions have no t3_model)."""
    try:
        allowed = set(inspect.signature(cls.from_pretrained).parameters)
    except (TypeError, ValueError):
        allowed = set()
    kwargs = {key: value for key, value in extra.items() if not allowed or key in allowed}
    return cls.from_pretrained(device=device, **kwargs)


# Peak memory while the multilingual model loads on the CPU (~2 GB of random weights + 2.1 GB file + s3gen)
NEEDED_COMMIT_GB = {"multilingual": 6.5, "english": 4.5, "turbo": 3.0, "nano": 2.0}


def available_commit_gb():
    """Windows: available commit (RAM + page file) and free RAM, in GB. None on every other system."""
    if os.name != "nt":
        return None
    try:
        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        status = MemoryStatus()
        status.dwLength = ctypes.sizeof(MemoryStatus)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
        return status.ullAvailPageFile / 1e9, status.ullAvailPhys / 1e9
    except Exception:
        return None


def memory_preflight(kind: str, device: str):
    """With too little memory the model load dies in a silent segfault (the console just closes); warn
    about it up front in readable terms. On CUDA the requirement is small (streamed loading + the model
    is built on the GPU)."""
    if device != "cpu":
        info = available_commit_gb()
        if info and info[0] < 2.5:
            print(f"[chatterbox] WARNING: available memory is {info[0]:.1f} GB; the GPU load needs at least ~2.5 GB. Close some applications.", flush=True)
        return
    info = available_commit_gb()
    if not info:
        return
    commit, ram = info
    needed = NEEDED_COMMIT_GB.get(kind, 6.5)
    if commit < needed:
        print(
            f"[chatterbox] WARNING: the '{kind}' model wants ~{needed:.1f} GB of memory on the CPU; only "
            f"{commit:.1f} GB is available right now (free RAM {ram:.1f} GB). The load will most likely crash.\n"
            "  Fix: close other applications, free up disk space (so the page file can grow) or use the GPU with a CUDA torch\n"
            "  (tools/setup-chatterbox.ps1). If English is enough, --model turbo needs far less memory.",
            flush=True,
        )


_SAFETENSORS_DTYPES = {
    "F32": "float32", "F16": "float16", "BF16": "bfloat16", "F64": "float64",
    "I64": "int64", "I32": "int32", "I16": "int16", "I8": "int8", "U8": "uint8", "BOOL": "bool",
}
CHUNK_BYTES = 64 * 1024 * 1024


def _read_into_tensor(f, base, info, target, chunk, view):
    """Copies one tensor from the file straight into the `target` tensor (which may be on the GPU) in 64 MB chunks."""
    import torch

    start, end = info["data_offsets"]
    total = end - start
    dtype = getattr(torch, _SAFETENSORS_DTYPES[info["dtype"]])
    if total == 0:
        return
    if target.dtype != dtype or not target.is_contiguous():
        # On a dtype mismatch, convert through a temporary tensor in the file's dtype (on the same device).
        temp = torch.empty(info["shape"], dtype=dtype, device=target.device)
        _read_into_tensor(f, base, info, temp, chunk, view)
        target.copy_(temp)
        return
    if target.numel() * target.element_size() != total:
        raise ValueError(f"size mismatch: file {total} bytes, tensor {target.numel() * target.element_size()} bytes")
    flat = target.view(-1).view(torch.uint8)
    f.seek(base + start)
    offset = 0
    while offset < total:
        want = min(len(chunk), total - offset)
        got = f.readinto(view[:want])
        if not got:
            raise IOError("safetensors read came up short")
        flat[offset : offset + got].copy_(torch.frombuffer(view[:got], dtype=torch.uint8))
        offset += got


class LazySafetensors:
    """Lazy mapping for a safetensors file: the weights are never collected into a dictionary, they are
    copied straight into the model's parameters (load_into). That way the model and a copy of the weights
    never sit on the GPU at the same time, and on the CPU no commit the size of the file is needed
    (Windows mmap error 1455)."""

    def __init__(self, path, device):
        self.path = str(path)
        self.device = device
        with open(self.path, "rb") as f:
            (header_len,) = struct.unpack("<Q", f.read(8))
            self.header = {k: v for k, v in json.loads(f.read(header_len)).items() if k != "__metadata__"}
            self.base = 8 + header_len

    def keys(self):
        return self.header.keys()

    def __contains__(self, key):
        return key in self.header

    def __len__(self):
        return len(self.header)

    def __iter__(self):
        return iter(self.header)

    def __getitem__(self, name):
        import torch

        info = self.header[name]
        target = torch.empty(info["shape"], dtype=getattr(torch, _SAFETENSORS_DTYPES[info["dtype"]]), device=self.device)
        chunk = bytearray(CHUNK_BYTES)
        with open(self.path, "rb") as f:
            _read_into_tensor(f, self.base, info, target, chunk, memoryview(chunk))
        return target

    def load_into(self, module, strict=True):
        import torch

        # Only the keys that end up in state_dict (non-persistent buffers, e.g. rotary inv_freq, excluded).
        expected = set(module.state_dict(keep_vars=True).keys())
        targets = {k: v for k, v in module.named_parameters() if k in expected}
        targets.update({k: v for k, v in module.named_buffers() if k in expected})
        missing = [k for k in expected if k not in self.header]
        unexpected = [k for k in self.header if k not in targets]
        if strict and (missing or unexpected):
            raise RuntimeError(f"state_dict mismatch: missing {missing[:5]} unexpected {unexpected[:5]}")
        chunk = bytearray(CHUNK_BYTES)
        view = memoryview(chunk)
        with torch.no_grad(), open(self.path, "rb") as f:
            for name, info in self.header.items():
                target = targets.get(name)
                if target is None:
                    continue
                _read_into_tensor(f, self.base, info, target.data if hasattr(target, "data") else target, chunk, view)
        return torch.nn.modules.module._IncompatibleKeys(missing, unexpected)


def streamed_safetensors(path, device="cpu"):
    """Returns every tensor as a dictionary (for small files/tests); the big model uses LazySafetensors."""
    lazy = LazySafetensors(path, device)
    return {name: lazy[name] for name in lazy.keys()}


@contextlib.contextmanager
def low_memory_load(device: str):
    """On CUDA: the model parameters are built straight on the graphics card, the safetensors weights are
    streamed from the file into those parameters (no intermediate copy) and large .pt files are read with
    mmap. On the CPU only the streamed safetensors part kicks in."""
    import torch

    try:
        import chatterbox.mtl_tts as mtl
    except Exception:
        mtl = None
    patches = []

    def patch(obj, name, value):
        patches.append((obj, name, getattr(obj, name)))
        setattr(obj, name, value)

    if mtl:
        patch(mtl, "load_safetensors", lambda path, *a, **k: LazySafetensors(path, device))
        t3_cls = getattr(mtl, "T3", None)
        if t3_cls is not None:
            original_lsd = t3_cls.load_state_dict

            def streaming_load_state_dict(self, state_dict, strict=True, assign=False):
                if isinstance(state_dict, LazySafetensors):
                    return state_dict.load_into(self, strict=strict)
                return original_lsd(self, state_dict, strict=strict, assign=assign)

            patch(t3_cls, "load_state_dict", streaming_load_state_dict)
    if device == "cuda":
        original_load = torch.load

        def frugal_load(f, *args, **kwargs):
            try:
                size = os.path.getsize(f)
            except (OSError, TypeError):
                size = 0
            if size > CHUNK_BYTES:
                kwargs["mmap"] = True
                kwargs["map_location"] = "cpu"
            return original_load(f, *args, **kwargs)

        patch(torch, "load", frugal_load)
    try:
        if device == "cuda":
            with torch.device("cuda"):
                yield
        else:
            yield
    finally:
        for obj, name, value in reversed(patches):
            setattr(obj, name, value)


def load_model(kind: str, device: str):
    """Loads the model. multilingual: 23+ languages (Turkish included), turbo/nano: fast English."""
    with low_memory_load(device):
        if kind == "multilingual":
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS

            return _from_pretrained(ChatterboxMultilingualTTS, device, t3_model="v3")
        if kind == "turbo":
            from chatterbox.tts_turbo import ChatterboxTurboTTS

            return _from_pretrained(ChatterboxTurboTTS, device)
        if kind == "nano":
            from chatterbox.tts_turbo import ChatterboxTurboTTS

            return _from_pretrained(ChatterboxTurboTTS, device, nano=True)
        from chatterbox.tts import ChatterboxTTS

        return _from_pretrained(ChatterboxTTS, device)


def accepted_params(model) -> set:
    """The parameters in the model's generate() signature: so version differences do not blow up."""
    try:
        return set(inspect.signature(model.generate).parameters)
    except (TypeError, ValueError):
        return set()


def synthesize(model, payload: dict) -> tuple[bytes, int]:
    text = str(payload.get("text") or "").strip()
    if not text:
        raise ValueError("text is empty")
    allowed = accepted_params(model)
    kwargs = {}
    voice_ref = checked_voice_ref(payload.get("voice_ref")) or STATE["voice_ref"]
    if voice_ref:
        kwargs["audio_prompt_path"] = voice_ref
    if STATE["kind"] == "multilingual":
        kwargs["language_id"] = str(payload.get("language_id") or "tr")
    for key, cast in (("exaggeration", float), ("cfg_weight", float)):
        if key in allowed or not allowed:
            if payload.get(key) is not None:
                kwargs[key] = cast(payload[key])
    dropped = [key for key in kwargs if allowed and key not in allowed]
    if dropped:
        print(f"[chatterbox] this model does not support these parameters, they were skipped: {', '.join(dropped)}", flush=True)
    kwargs = {key: value for key, value in kwargs.items() if not allowed or key in allowed}

    with STATE["lock"]:  # a single model instance: queue the requests up
        wav = model.generate(text, **kwargs)
    import torch

    samples = wav.squeeze(0).detach().to("cpu", dtype=torch.float32).clamp(-1.0, 1.0).numpy()
    pcm = (samples * 32767.0).astype("<i2").tobytes()
    return pcm, int(getattr(model, "sr", 24000))


class QuietServer(ThreadingHTTPServer):
    """When the client dropped the connection (the bot cancels the request on barge-in) stay quiet instead
    of printing a traceback."""

    # main() sets these from the arguments; the defaults admit loopback names only and ask for no token.
    quiet = False
    allowed_hosts = frozenset(LOOPBACK_NAMES)
    token = None

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def patch_alignment_analyzer():
    """With five or fewer text tokens (e.g. "Yes?") Chatterbox's alignment analyzer calls max() on an empty
    slice and raises IndexError. We recompile its source at runtime with a guard condition and swap the class."""
    try:
        import chatterbox.models.t3.inference.alignment_stream_analyzer as asa
        import chatterbox.models.t3.t3 as t3_module
    except Exception as err:
        print(f"[chatterbox] alignment patch skipped: {err}", flush=True)
        return
    src = inspect.getsource(asa)
    fixes = {
        "A[self.completed_at:, :-5].max(dim=1).values.sum() > 5":
            "(A[self.completed_at:, :-5].max(dim=1).values.sum() > 5 if A.shape[1] > 5 and A[self.completed_at:].shape[0] > 0 else False)",
        "A[self.completed_at:, -3:].sum(dim=0).max() >= 5":
            "(A[self.completed_at:, -3:].sum(dim=0).max() >= 5 if A[self.completed_at:].shape[0] > 0 else False)",
    }
    missing = [needle for needle in fixes if needle not in src]
    if missing:
        print(f"[chatterbox] alignment patch could not be applied (the library source has changed): {missing[0][:40]}…", flush=True)
        return
    for needle, guarded in fixes.items():
        src = src.replace(needle, guarded)
    namespace = dict(asa.__dict__)
    exec(compile(src, asa.__file__, "exec"), namespace)
    patched = namespace["AlignmentStreamAnalyzer"]
    patched.short_text_safe = True  # verification marker
    asa.AlignmentStreamAnalyzer = patched
    t3_module.AlignmentStreamAnalyzer = patched
    print("[chatterbox] short-text alignment patch applied", flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # turn the default noise down
        if self.server.quiet:
            return
        print(f"[chatterbox] {self.address_string()} {fmt % args}", flush=True)

    def _json(self, status: int, payload: dict, close: bool = False):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        if close:
            # The request body was not read, so this connection cannot carry another request.
            self.send_header("connection", "close")
            self.close_connection = True
        self.end_headers()
        self._write(body)

    def _refused(self) -> bool:
        """Answers 403 and returns True when the request fails the Host, Origin or token check."""
        reason = request_refusal(self.headers, self.server.allowed_hosts, self.server.token)
        if reason is None:
            return False
        print(f"[chatterbox] refused {self.command} {self.path.split('?')[0]} from {self.address_string()}: {reason}", flush=True)
        self._json(403, {"ok": False, "error": reason}, close=True)
        return True

    def _content_type_is(self, expected: str) -> bool:
        """Answers 415 and returns False unless the body is declared as `expected`."""
        given = (self.headers.get("content-type") or "").split(";")[0].strip().lower()
        if given == expected:
            return True
        self._json(415, {"ok": False, "error": f"content-type must be {expected}"}, close=True)
        return False

    def _write(self, data: bytes):
        """When the client cancelled the request (barge-in) give up quietly; do not print a traceback."""
        try:
            self.wfile.write(data)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            print("[chatterbox] the client cancelled the request (barge-in); the result was dropped", flush=True)

    def _read_json(self) -> dict:
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError as err:
            raise json.JSONDecodeError("invalid content-length", "", 0) from err
        if length > MAX_BODY_BYTES:
            raise json.JSONDecodeError(f"body too large (> {MAX_BODY_BYTES} bytes)", "", 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except UnicodeDecodeError as err:
            raise json.JSONDecodeError("body is not UTF-8", "", 0) from err

    def _handle_stt(self):
        if STATE["stt"] is None:
            self._json(503, {"ok": False, "error": "the STT model is not loaded (start the server with --stt small)"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            sample_rate = int(self.headers.get("x-sample-rate") or 16000)
        except ValueError:
            self._json(400, {"ok": False, "error": "invalid header"})
            return
        if length <= 0 or length > MAX_STT_BYTES:
            self._json(400, {"ok": False, "error": f"body is empty or too large (> {MAX_STT_BYTES} bytes)"})
            return
        raw = self.rfile.read(length)
        from urllib.parse import parse_qs, urlsplit

        query = parse_qs(urlsplit(self.path).query)
        language = (query.get("language") or [None])[0] or None
        prompt = (query.get("prompt") or [None])[0] or None
        try:
            text, detected, duration = transcribe(raw, sample_rate, language, prompt)
        except Exception as err:
            traceback.print_exc()
            self._json(500, {"ok": False, "error": str(err)})
            return
        self._json(200, {"ok": True, "text": text, "language": detected, "duration": duration})

    def do_GET(self):
        if self._refused():
            return
        if self.path.split("?")[0] != "/health":
            self._json(404, {"ok": False, "error": "not found"})
            return
        self._json(
            200,
            {
                "ok": STATE["model"] is not None,
                "status": "ready" if STATE["model"] is not None else ("error" if STATE.get("load_error") else "loading"),
                "model": STATE["kind"],
                "sr": STATE["sr"],
                "device": STATE["device"],
                "voice": STATE["voice_ref"],
                "stt": STATE["stt_name"] if STATE["stt"] is not None else None,
                "error": (STATE.get("load_error") or "").splitlines()[-1] if STATE.get("load_error") else None,
            },
        )

    def do_POST(self):
        if self._refused():
            return
        path = self.path.split("?")[0]
        if path == "/stt":
            if self._content_type_is("application/octet-stream"):
                self._handle_stt()
            return
        # A page can post text/plain or a form without asking first; only a JSON body is taken here.
        if not self._content_type_is("application/json"):
            return
        try:
            payload = self._read_json()
        except json.JSONDecodeError as err:
            self._json(400, {"ok": False, "error": f"invalid JSON: {err}"})
            return
        if not isinstance(payload, dict):
            self._json(400, {"ok": False, "error": "the body must be a JSON object"})
            return

        if path == "/voice":
            try:
                STATE["voice_ref"] = checked_voice_ref(payload.get("voice_ref"))
            except ValueError as err:
                self._json(400, {"ok": False, "error": str(err)})
                return
            print(f"[chatterbox] reference voice: {STATE['voice_ref']}", flush=True)
            self._json(200, {"ok": True, "voice": STATE["voice_ref"]})
            return

        if path == "/shutdown":
            self._json(200, {"ok": True})
            STATE["stop"].set()
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return

        if path != "/tts":
            self._json(404, {"ok": False, "error": "not found"})
            return

        if STATE["model"] is None:
            self._json(503, {"ok": False, "error": "the model is not loaded yet"})
            return
        try:
            pcm, sr = synthesize(STATE["model"], payload)
        except ValueError as err:  # client errors such as empty text
            self._json(400, {"ok": False, "error": str(err)})
            return
        except Exception as err:  # return a meaningful error to the client
            traceback.print_exc()
            self._json(500, {"ok": False, "error": str(err)})
            return
        self.send_response(200)
        self.send_header("content-type", "application/octet-stream")
        self.send_header("x-sample-rate", str(sr))
        self.send_header("x-channels", "1")
        self.send_header("content-length", str(len(pcm)))
        self.end_headers()
        self._write(pcm)


def main():
    parser = argparse.ArgumentParser(description="Chatterbox local TTS server")
    parser.add_argument("--port", type=int, default=8020)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--model", default="multilingual", choices=["multilingual", "turbo", "nano", "english"])
    parser.add_argument("--device", default="cuda" if _cuda() else "cpu")
    parser.add_argument("--voice", default=None, help="default reference voice (path to a wav)")
    parser.add_argument("--stt", default=None, help="faster-whisper model (tiny/base/small/medium/large-v3); empty = STT off")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument(
        "--token",
        default=os.environ.get("CHATTERBOX_TOKEN") or None,
        help="require this value in the X-Chatterbox-Token header (default: $CHATTERBOX_TOKEN; the environment "
        "is the better place, a command line is visible to every account on the machine)",
    )
    args = parser.parse_args()

    STATE["kind"] = args.model
    STATE["device"] = args.device
    STATE["voice_ref"] = args.voice

    # Open the port FIRST so the client can see the "loading" status (it answers while the model downloads).
    server = QuietServer((args.host, args.port), Handler)
    server.quiet = args.quiet
    server.daemon_threads = True
    server.allowed_hosts = allowed_host_names(args.host)
    server.token = args.token.encode("utf-8") if args.token else None
    print(f"[chatterbox] listening on: http://{args.host}:{args.port} (model loading)", flush=True)
    if server.token is not None:
        print(f"[chatterbox] requests must carry the {TOKEN_HEADER} header", flush=True)
    elif server.allowed_hosts is None:
        print(
            f"[chatterbox] WARNING: bound to {args.host} without a token; anything that reaches this port can use "
            "the server (set CHATTERBOX_TOKEN)",
            flush=True,
        )
    threading.Thread(target=server.serve_forever, daemon=True).start()

    print(f"[chatterbox] loading model: {args.model} ({args.device}) — downloaded on the first run", flush=True)
    memory_preflight(args.model, args.device)
    patch_alignment_analyzer()
    try:
        STATE["model"] = load_model(args.model, args.device)
    except Exception:
        STATE["load_error"] = traceback.format_exc()
        print(STATE["load_error"], flush=True)
        server.shutdown()
        raise
    STATE["sr"] = int(getattr(STATE["model"], "sr", 24000))
    print(f"[chatterbox] ready — sr={STATE['sr']} device={args.device}", flush=True)

    if args.stt:
        print(f"[chatterbox] loading STT: faster-whisper {args.stt} ({args.device})", flush=True)
        try:
            STATE["stt"] = load_stt(args.stt, args.device)
            STATE["stt_name"] = args.stt
            print("[chatterbox] STT ready", flush=True)
        except Exception:
            traceback.print_exc()
            print("[chatterbox] STT could not be loaded; TTS keeps working (pip install faster-whisper)", flush=True)

    try:
        STATE["stop"].wait()  # /shutdown or Ctrl+C
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        print("[chatterbox] shut down", flush=True)


def _cuda() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


if __name__ == "__main__":
    faulthandler.enable()  # on a native crash (segfault) print the Python trace; do not let the console close silently
    main()
