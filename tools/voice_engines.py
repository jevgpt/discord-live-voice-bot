"""The speech engines tools/chatterbox_server.py can answer a /tts request with, behind one small interface.

Three engines, three different bargains:
    chatterbox  Chatterbox, multilingual (Turkish included): clones a reference voice. Autoregressive, so it
                can ramble or invent words, more so on a weak GPU; it wants ~4 GB of free VRAM.
    freya       FreyaTTS-small: Turkish only, one voice (Leyla), no cloning. Non-autoregressive, so it says
                the text it was given and nothing else; ~1.5 GB of VRAM, usable on a CPU. 48 kHz.
    pocket      Kyutai Pocket TTS: English, French, German, Italian, Portuguese, Spanish, Dutch; clones a
                reference voice; ~100M parameters made for the CPU, one model per language. 24 kHz.

Nothing here imports torch or a model library when it is imported. An engine is probed with
importlib.util.find_spec and loaded the first time something is routed to it, so the server starts on a
machine that has only some of the engines installed, and the tests run on one that has none of them.

Routing ("auto"), one rule per line:
    Turkish                      -> freya, else chatterbox
    en fr de it pt es nl         -> pocket, else chatterbox
    any other language           -> chatterbox
    a reference voice to clone   -> pocket for its languages (it clones), chatterbox for the rest; with
                                    neither able to, the line is still spoken, in the engine's own voice
An engine that is not installed, not enabled (--engines) or failed to load within the last minute is
skipped, and the next one on its line answers.

Memory: an engine is loaded only when a request (or the start-up preload) is routed to it, and once
loaded it stays. A conversation that switches language sentence by sentence would otherwise reload a
model every few seconds. What keeps a second engine from pushing the first one out is where it goes: on
the GPU only when the VRAM that is free with the first one already there covers what it needs, otherwise
on the CPU; and on the CPU not at all when the free RAM does not cover it while another engine is loaded,
because a failed allocation there takes the whole process down, the first engine with it. Auto routing
then answers with the engine that is loaded. Pocket keeps at most two language models; a third language
drops the one used least recently.
"""

import array
import ctypes
import importlib.util
import math
import os
import sys
import threading
import time
import traceback
from collections import OrderedDict
from pathlib import Path

ENGINE_NAMES = ("chatterbox", "freya", "pocket")

# Pocket's languages, by the code a request carries (language_id) -> the name of Pocket's model config.
POCKET_LANGUAGES = {
    "en": "english",
    "fr": "french",
    "de": "german",
    "it": "italian",
    "pt": "portuguese",
    "es": "spanish",
    "nl": "dutch",
}
FREYA_LANGUAGES = ("tr",)
# What Chatterbox's multilingual model speaks; its English variants (turbo, nano, english) speak "en".
CHATTERBOX_LANGUAGES = (
    "ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja",
    "ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh",
)
# The languages /health lists a route for; every other one goes where its "*" entry says.
ROUTED_LANGUAGES = FREYA_LANGUAGES + tuple(POCKET_LANGUAGES)
# A code no engine lists, for asking the routing where "any other language" goes.
OTHER_LANGUAGE = "xx"

# How long an engine that failed to load is left alone. Retrying on every request would make each one
# wait for a load that is going to fail again; never retrying would leave a download that broke once
# broken until the server restarts.
LOAD_RETRY_SECONDS = 60.0
# Pocket loads one model per language (~0.5 GB each on the CPU) and keeps this many.
POCKET_MAX_MODELS = 2
# Voice states Pocket keeps (encoding a reference recording takes a second or two).
POCKET_MAX_VOICES = 4

# What a reference voice can be: the model reads it as audio, so nothing else on the disk is accepted.
AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac"}

# Tuning a request may carry. Only these names ever reach an engine, and only an engine that declares a
# name gets it: a request cannot hand a model an argument such as audio_prompt_path and so get around
# checked_voice_ref. Every value is a number inside a range, because steps and the like multiply the work.
OPTION_SPECS = {
    "seed": (int, 0, 2**32 - 1),
    "steps": (int, 1, 100),
    "temperature": (float, 0.0, 5.0),
    "top_p": (float, 0.0, 1.0),
    "min_p": (float, 0.0, 1.0),
    "repetition_penalty": (float, 0.0, 10.0),
    "exaggeration": (float, 0.0, 10.0),
    "cfg_weight": (float, 0.0, 10.0),
}

# What tools/check-chatterbox.py imports to say an engine really works (the server only probes for it).
ENGINE_IMPORTS = {
    "chatterbox": ("chatterbox.mtl_tts", "ChatterboxMultilingualTTS"),
    "freya": ("freyatts", "FreyaTTS"),
    "pocket": ("pocket_tts", "TTSModel"),
}


class EngineUnavailable(RuntimeError):
    """The request is fine, but no engine can take it right now (HTTP 503)."""


def checked_voice_ref(value):
    """A reference voice from a request: None for none, else the resolved path of an existing audio file.
    Anything else raises ValueError, so a request cannot point a model at an arbitrary file (and never at
    a URL or a .safetensors state, both of which Pocket would otherwise fetch or load)."""
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValueError("voice_ref must be a file path")
    path = os.path.realpath(value)
    if os.path.splitext(path)[1].lower() not in AUDIO_EXTENSIONS or not os.path.isfile(path):
        raise ValueError(f"voice_ref must be an existing audio file ({', '.join(sorted(AUDIO_EXTENSIONS))})")
    return path


def normalize_language(value, default="tr"):
    """'tr', 'TR', 'tr-TR' and 'tr_TR' -> 'tr'; empty -> `default` (Turkish, what the server always assumed)."""
    text = str(value or "").strip().lower().replace("_", "-")
    code = text.split("-")[0]
    if not code:
        return default
    if not (2 <= len(code) <= 3 and code.isascii() and code.isalpha()):
        raise ValueError("language_id must be a language code such as tr or en")
    return code


def request_options(payload):
    """The tuning fields of a request, checked and cast (see OPTION_SPECS); ValueError on a bad value."""
    options = {}
    for key, (cast, low, high) in OPTION_SPECS.items():
        value = payload.get(key)
        if value is None:
            continue
        if isinstance(value, bool):
            raise ValueError(f"{key} must be a number")
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError):
            raise ValueError(f"{key} must be a number") from None
        if not math.isfinite(number) or number < low or number > high:
            raise ValueError(f"{key} must be between {low} and {high}")
        if cast is int:
            if not number.is_integer():
                raise ValueError(f"{key} must be a whole number")
            options[key] = int(number)
        else:
            options[key] = number
    return options


def parse_engine_list(text):
    """'freya, pocket' -> ['freya', 'pocket'] in the canonical order; empty or 'all' -> every engine."""
    names = [part.strip().lower() for part in str(text or "").split(",") if part.strip()]
    if not names or names == ["all"]:
        return list(ENGINE_NAMES)
    unknown = [name for name in names if name not in ENGINE_NAMES]
    if unknown:
        raise ValueError(f"unknown engine: {', '.join(unknown)} (known: {', '.join(ENGINE_NAMES)})")
    return [name for name in ENGINE_NAMES if name in names]


def module_installed(name):
    """Whether `name` can be imported, found without importing it."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def choose_device(ceiling, need_gb, free_gb):
    """Where an engine loads. `ceiling` is the server's --device; `need_gb` the free VRAM the engine needs
    there (None: it stays on the CPU); `free_gb` what CUDA reports free right now (None: unknown, which
    counts as not enough, since guessing wrong here is an out-of-memory error in the middle of a load)."""
    ceiling = ceiling or "cpu"
    if need_gb is None or ceiling == "cpu":
        return "cpu"
    if not ceiling.startswith("cuda"):
        return ceiling  # mps and the like: there is no free-memory figure to go by
    if free_gb is None or free_gb < need_gb:
        return "cpu"
    return ceiling


def cuda_free_gb(device="cuda"):
    """Free VRAM on `device` in GB (torch.cuda.mem_get_info), or None without torch or CUDA."""
    try:
        import torch

        if not torch.cuda.is_available():
            return None
        index = device.split(":", 1)[1] if ":" in device else None
        free, _total = torch.cuda.mem_get_info(int(index)) if index is not None else torch.cuda.mem_get_info()
        return free / 1e9
    except Exception:
        return None


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


def available_ram_gb():
    """The memory a new model can take, in GB: the available commit on Windows (where running out of it is
    what kills a load), MemAvailable on Linux; None where it cannot be read, and the check is skipped."""
    if os.name == "nt":
        info = available_commit_gb()
        return info[0] if info else None
    try:
        with open("/proc/meminfo", encoding="ascii") as meminfo:
            for line in meminfo:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) / 1e6
    except (OSError, ValueError, IndexError):
        pass
    return None


def to_pcm16(samples):
    """A waveform in [-1, 1] as little-endian int16 PCM bytes: a torch tensor or a numpy array of any shape
    that holds one channel, or a plain sequence of floats."""
    if hasattr(samples, "detach"):  # torch
        samples = samples.detach().to("cpu").float().numpy()
    if hasattr(samples, "reshape"):  # numpy
        import numpy as np

        data = np.nan_to_num(np.asarray(samples, dtype=np.float32).reshape(-1))
        return (np.clip(data, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    out = array.array("h", (int(max(-1.0, min(1.0, float(value))) * 32767.0) for value in samples))
    if sys.byteorder == "big":
        out.byteswap()
    return out.tobytes()


def auto_route(language, cloning, usable, clones):
    """The engine auto routing gives a line, or None when no engine can take it. `usable(name)` says whether
    an engine may take a request at all (enabled, installed, not failing), `clones(name)` whether it can
    clone a reference voice. The table is at the top of this file."""
    if cloning:
        if language in POCKET_LANGUAGES and usable("pocket") and clones("pocket"):
            return "pocket"
        if usable("chatterbox"):
            return "chatterbox"
        # Nothing that clones can take it: the voice is lost, the words are not.
    if language in FREYA_LANGUAGES and usable("freya"):
        return "freya"
    if language in POCKET_LANGUAGES and usable("pocket"):
        return "pocket"
    if usable("chatterbox"):
        return "chatterbox"
    return None


class Engine:
    """One speech engine. A subclass sets the class attributes and writes loaded/load/synthesize.

    available()              whether its libraries are installed (import probing; nothing is imported)
    load(device, language)   loads the model; VoiceEngines.ensure_loaded calls it under `lock`, once
    synthesize(text, language, voice, options) -> (int16 PCM bytes, sample rate)
                             `voice` is a checked path to a reference recording or None, and `options`
                             holds only the tuning fields this engine declares in `options`
    """

    name = "engine"
    languages = ()
    supports_cloning = False
    per_language = False  # one model per language (Pocket), rather than one for all of them
    vram_gb = None  # free VRAM a GPU load needs; None: the engine stays on the CPU
    ram_gb = 1.0  # free RAM a CPU load needs
    options = frozenset()
    modules = ()
    notes = ""

    def __init__(self):
        self.device = None
        self.placement = None  # why it went where it went, for /health
        self.sample_rate = 24000
        self.error = None
        self.failed_at = None
        # One model instance does one thing at a time, loading or speaking one line: requests for the same
        # engine queue here, while two engines work side by side.
        self.lock = threading.Lock()

    def available(self):
        return all(module_installed(module) for module in self.modules)

    def speaks(self, language):
        return language in self.languages

    def loaded(self, language=None):
        raise NotImplementedError

    def load(self, device, language=None):
        raise NotImplementedError

    def synthesize(self, text, language, voice, options):
        raise NotImplementedError


class FreyaEngine(Engine):
    name = "freya"
    languages = FREYA_LANGUAGES
    vram_gb = 2.0  # 1.5 GB measured on an RTX 4090, and room to work in
    ram_gb = 2.5  # 183M parameters in float32 plus the VoxCPM2 audio decoder
    options = frozenset({"seed", "steps"})
    modules = ("freyatts", "torch")
    notes = (
        "FreyaTTS-small: Turkish only, one voice (Leyla), no cloning; non-autoregressive, it says the text "
        "and nothing else; 48 kHz"
    )
    repo = "freyavoice/freya-tts"

    def __init__(self):
        super().__init__()
        self.model = None
        self.sample_rate = 48000

    def loaded(self, language=None):
        return self.model is not None

    def load(self, device, language=None):
        from freyatts import FreyaTTS

        model = FreyaTTS.from_pretrained(self.repo, device=device)
        self.model = model
        self.device = device
        self.sample_rate = int(getattr(model, "sample_rate", 48000))

    def synthesize(self, text, language, voice, options):
        # One voice and no cloning, so `voice` is not used. Its seed picks the speaker: the default one is
        # Leyla, and a request that sends another gets somebody else.
        wav = self.model.synthesize(text, **{key: options[key] for key in ("steps", "seed") if key in options})
        return to_pcm16(wav), self.sample_rate


class PocketEngine(Engine):
    name = "pocket"
    languages = tuple(POCKET_LANGUAGES)
    # Until a load says otherwise: the cloning weights are gated on Hugging Face (accept the terms on the
    # kyutai/pocket-tts page and log in), and without them Pocket loads the ones that cannot clone.
    supports_cloning = True
    per_language = True
    vram_gb = None
    ram_gb = 1.0
    options = frozenset({"seed", "temperature"})
    modules = ("pocket_tts", "torch")
    notes = (
        "Kyutai Pocket TTS: en fr de it pt es nl on the CPU, one model per language; clones a reference "
        "voice with the gated weights; 24 kHz"
    )

    def __init__(self, max_models=POCKET_MAX_MODELS):
        super().__init__()
        self.models = OrderedDict()  # language -> model, least recently used first
        self.voices = OrderedDict()  # (language, voice path or None) -> model state
        self.max_models = max_models

    def loaded(self, language=None):
        if language is None:
            return bool(self.models)
        return language in self.models

    def load(self, device, language=None):
        from pocket_tts import TTSModel

        code = language if language in POCKET_LANGUAGES else "en"
        while len(self.models) >= self.max_models:
            dropped, _model = self.models.popitem(last=False)
            self.voices = OrderedDict((key, state) for key, state in self.voices.items() if key[0] != dropped)
        model = TTSModel.load_model(language=POCKET_LANGUAGES[code])
        self.models[code] = model
        # Pocket is made for the CPU, and its int8 path only works there; the GPU is left to the others.
        self.device = "cpu"
        self.sample_rate = int(getattr(model, "sample_rate", 24000))
        self.supports_cloning = bool(getattr(model, "has_voice_cloning", True))

    def voice_state(self, model, code, voice):
        """The model state for a voice: the reference recording's (a Path, so Pocket reads the file and never
        takes it for a URL), or the language's own default voice."""
        key = (code, voice)
        if key in self.voices:
            self.voices.move_to_end(key)
            return self.voices[key]
        if voice:
            state = model.get_state_for_audio_prompt(Path(voice), truncate=True)
        else:
            from pocket_tts.default_parameters import get_default_voice_for_language

            state = model.get_state_for_audio_prompt(get_default_voice_for_language(POCKET_LANGUAGES[code]))
        self.voices[key] = state
        while len(self.voices) > POCKET_MAX_VOICES:
            self.voices.popitem(last=False)
        return state

    def synthesize(self, text, language, voice, options):
        model = self.models[language]
        self.models.move_to_end(language)
        if voice and not getattr(model, "has_voice_cloning", True):
            voice = None
        state = self.voice_state(model, language, voice)
        # The temperature is the model's own setting, read on every step; it is put back afterwards, so a
        # request that sets one does not set it for the next.
        previous = model.temp
        if "temperature" in options:
            model.temp = options["temperature"]
        try:
            if "seed" in options:
                import torch

                torch.manual_seed(options["seed"])
            audio = model.generate_audio(state, text)
        finally:
            model.temp = previous
        return to_pcm16(audio), int(getattr(model, "sample_rate", self.sample_rate))


class VoiceEngines:
    """The engines of one server: which of them may load (--engines), which one a request that names none
    gets (--tts-engine), where each one loads, and the routing between them."""

    def __init__(
        self,
        engines,
        enabled=None,
        default="auto",
        device="cpu",
        free_vram=cuda_free_gb,
        free_ram=available_ram_gb,
        log=None,
        clock=time.monotonic,
    ):
        self.engines = {engine.name: engine for engine in engines}
        self.enabled = set(self.engines) if enabled is None else set(enabled) & set(self.engines)
        self.default = default
        self.device = device or "cpu"
        self.free_vram = free_vram
        self.free_ram = free_ram
        self.log = log or (lambda message: None)
        self.clock = clock
        # Probed once: whether a library is installed does not change while the server runs.
        self.installed = {name: bool(engine.available()) for name, engine in self.engines.items()}

    # ---------------------------------------------------------------- routing

    def cooling(self, engine):
        return engine.failed_at is not None and self.clock() - engine.failed_at < LOAD_RETRY_SECONDS

    def usable(self, name):
        engine = self.engines.get(name)
        return engine is not None and name in self.enabled and self.installed[name] and not self.cooling(engine)

    def route(self, language, cloning):
        return auto_route(language, cloning, self.usable, lambda name: self.engines[name].supports_cloning)

    def requested(self, value):
        """The engine a request names: its `engine` field, or the server's default when it names none (or
        names auto). ValueError for a name that is not an engine."""
        if value is None or value == "":
            name = "auto"
        elif not isinstance(value, str):
            raise ValueError("engine must be a string")
        else:
            name = value.strip().lower() or "auto"
        if name != "auto" and name not in ENGINE_NAMES:
            raise ValueError(f"unknown engine '{value}' (auto, {', '.join(ENGINE_NAMES)})")
        return self.default if name == "auto" else name

    def pick(self, requested, language, cloning):
        """The engine that answers a line. `requested` is auto or a name, as requested() gave it. A named
        engine is taken as named or refused, never swapped for another: ValueError when the request itself
        is wrong (a language the engine does not speak), EngineUnavailable when it cannot be served now."""
        if requested == "auto":
            name = self.route(language, cloning)
            if name is None:
                raise EngineUnavailable(f"no enabled, installed engine speaks '{language}' ({self.summary()})")
            return name
        if requested not in self.enabled:
            enabled = ",".join(name for name in ENGINE_NAMES if name in self.enabled) or "none"
            raise EngineUnavailable(f"the {requested} engine is not enabled on this server (--engines {enabled})")
        engine = self.engines[requested]
        if not self.installed[requested]:
            raise EngineUnavailable(
                f"the {requested} engine is not installed (tools/setup-chatterbox.ps1 -Engines ... or "
                "tools/setup-voice.sh --engines ...)"
            )
        if self.cooling(engine):
            raise EngineUnavailable(f"the {requested} engine failed to load: {engine.error}")
        if not engine.speaks(language):
            raise ValueError(f"the {requested} engine does not speak '{language}' (it speaks {', '.join(engine.languages)})")
        return requested

    # ---------------------------------------------------------------- loading

    def placement(self, engine):
        """Where `engine` loads and why, in words for the log and /health."""
        if engine.vram_gb is None:
            return "cpu", "made for the CPU"
        if self.device == "cpu":
            return "cpu", "the server runs on the CPU (--device cpu)"
        if not self.device.startswith("cuda"):
            return self.device, f"--device {self.device}"
        free = self.free_vram(self.device)
        device = choose_device(self.device, engine.vram_gb, free)
        if free is None:
            return device, "CUDA gave no free VRAM figure"
        verdict = "enough" if device != "cpu" else "not enough, so the CPU"
        return device, f"{free:.1f} GB of VRAM free, it needs ~{engine.vram_gb:.1f} GB: {verdict}"

    def check_memory(self, engine, device):
        """Refuses a CPU load the free RAM does not cover while another engine is loaded (see the top of
        this file); alone, the load is only warned about, since there is nothing to protect."""
        if device != "cpu":
            return
        free = self.free_ram()
        if free is None or free >= engine.ram_gb:
            return
        resident = [other.name for other in self.engines.values() if other.loaded()]
        if resident:
            raise EngineUnavailable(
                f"not enough memory to load {engine.name} next to {', '.join(resident)}: "
                f"{free:.1f} GB free, it needs ~{engine.ram_gb:.1f} GB"
            )
        self.log(
            f"WARNING: {engine.name} wants ~{engine.ram_gb:.1f} GB of memory on the CPU and {free:.1f} GB is "
            "free; the load may fail. Close other applications, or use the GPU."
        )

    def ensure_loaded(self, engine, language=None):
        """Loads `engine` (for `language`, where it keeps one model per language) unless it is loaded. The
        caller holds engine.lock, so concurrent requests wait here for one load instead of starting two."""
        if engine.loaded(language if engine.per_language else None):
            return
        if self.cooling(engine):
            raise EngineUnavailable(f"the {engine.name} engine failed to load: {engine.error}")
        device, why = self.placement(engine)
        which = f"{engine.name} ({language})" if engine.per_language and language else engine.name
        try:
            self.check_memory(engine, device)
            self.log(f"loading {which} on {device} ({why}); downloaded on the first run")
            engine.load(device, language)
        except Exception as err:
            engine.error = (str(err).strip().splitlines() or [type(err).__name__])[-1][:300]
            engine.failed_at = self.clock()
            if not isinstance(err, EngineUnavailable):
                self.log(traceback.format_exc().rstrip())
            self.log(f"{which} could not be loaded: {engine.error}")
            raise EngineUnavailable(f"the {engine.name} engine could not be loaded: {engine.error}") from err
        engine.error = None
        engine.failed_at = None
        engine.placement = why
        self.log(f"{which} ready on {engine.device} ({engine.sample_rate} Hz)")

    def preload(self, spec, cloning=False):
        """Loads at start what `spec` asks for, so that the first line spoken is not the one that waits for a
        model: 'all' = every enabled, installed engine; 'none' = nothing; otherwise language codes, each
        loading the engine the routing gives it. Returns (loaded, failed)."""
        spec = str(spec or "all").strip().lower()
        if spec == "none":
            return 0, 0
        targets = []
        if spec == "all":
            for name in ENGINE_NAMES:
                if name in self.engines and name in self.enabled and self.installed[name]:
                    engine = self.engines[name]
                    targets.append((engine, engine.languages[0] if engine.per_language else None))
        else:
            for code in spec.split(","):
                if not code.strip():
                    continue
                try:
                    language = normalize_language(code)
                    name = self.pick(self.default, language, cloning)
                except (ValueError, EngineUnavailable) as err:
                    self.log(f"nothing to preload for '{code.strip()}': {err}")
                    continue
                engine = self.engines[name]
                targets.append((engine, language if engine.per_language else None))
        loaded = failed = 0
        for engine, language in dict.fromkeys(targets):
            with engine.lock:
                try:
                    self.ensure_loaded(engine, language)
                    loaded += 1
                except EngineUnavailable:
                    failed += 1
        return loaded, failed

    # ---------------------------------------------------------------- speaking

    def synthesize(self, payload, default_voice=None):
        """One /tts request -> (int16 PCM bytes, sample rate, the engine that answered). ValueError for a
        request that is wrong (400), EngineUnavailable for one that cannot be served now (503)."""
        text = str(payload.get("text") or "").strip()
        if not text:
            raise ValueError("text is empty")
        language = normalize_language(payload.get("language_id"))
        voice = checked_voice_ref(payload.get("voice_ref")) or default_voice
        options = request_options(payload)
        requested = self.requested(payload.get("engine"))
        cloning = voice is not None
        failure = None
        for _attempt in range(len(self.engines) + 1):
            try:
                name = self.pick(requested, language, cloning)
            except EngineUnavailable:
                if failure is not None:
                    raise failure from None  # what made the routing run out is the more useful error
                raise
            engine = self.engines[name]
            with engine.lock:
                try:
                    self.ensure_loaded(engine, language)
                except EngineUnavailable as err:
                    if requested != "auto":
                        raise
                    failure = err
                    continue  # it is cooling down now, so the routing moves on to the next engine
                if requested == "auto" and cloning and not engine.supports_cloning and self.route(language, cloning) != name:
                    continue  # its load showed it cannot clone (Pocket without the gated weights): route again
                accepted = {key: value for key, value in options.items() if key in engine.options}
                pcm, rate = engine.synthesize(text, language, voice if engine.supports_cloning else None, accepted)
            return pcm, int(rate), name
        raise failure or EngineUnavailable("no engine could take the request")

    # ---------------------------------------------------------------- reporting

    def describe(self, name):
        engine = self.engines[name]
        return {
            "available": self.installed[name],
            "enabled": name in self.enabled,
            "loaded": engine.loaded(),
            "device": engine.device,
            "placement": engine.placement,
            "languages": list(engine.languages),
            "cloning": engine.supports_cloning,
            "sample_rate": engine.sample_rate,
            "error": engine.error,
            "notes": engine.notes,
        }

    def routes(self, cloning):
        """Language -> the engine a request that names none would get right now ("*": any other language)."""
        table = {}
        for language in ROUTED_LANGUAGES + ("*",):
            try:
                table[language] = self.pick(self.default, OTHER_LANGUAGE if language == "*" else language, cloning)
            except (ValueError, EngineUnavailable):
                table[language] = None
        return table

    def health(self):
        return {
            "engine": self.default,
            "engines": {name: self.describe(name) for name in ENGINE_NAMES if name in self.engines},
            "routing": self.routes(False),
            "routing_voice": self.routes(True),
        }

    def sample_rate(self):
        """The sample rate of the first loaded engine (24 kHz before any)."""
        for name in ENGINE_NAMES:
            engine = self.engines.get(name)
            if engine is not None and engine.loaded():
                return engine.sample_rate
        return 24000

    def summary(self):
        """'chatterbox on cuda, freya installed, pocket not installed', for the log and error messages."""
        parts = []
        for name in ENGINE_NAMES:
            engine = self.engines.get(name)
            if engine is None:
                continue
            if name not in self.enabled:
                state = "off"
            elif not self.installed[name]:
                state = "not installed"
            elif engine.loaded():
                state = f"on {engine.device}"
            elif engine.error:
                state = "failed"
            else:
                state = "installed"
            parts.append(f"{name} {state}")
        return ", ".join(parts)
