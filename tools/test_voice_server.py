"""The voice server's engines, routing, protocol and request checks.

    python3 -m unittest tools/test_voice_server.py

No torch, numpy or model library is needed. The engines the routing and the HTTP server are tested with
are fakes behind the same interface as the real ones; the real adapters (Chatterbox, FreyaTTS, Pocket
TTS) are driven through fake libraries placed where the real ones would be imported from, so what they
call and with what is checked, while the sound itself can only be checked on a machine with the models.
"""

import contextlib
import http.client
import io
import json
import os
import socket
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import chatterbox_server as server  # noqa: E402
import voice_engines as ve  # noqa: E402

POCKET = set(ve.POCKET_LANGUAGES)
PCM = b"\x10\x00\x20\x00"


class FakeEngine(ve.Engine):
    """An engine that loads (after `load_delay`) and speaks at once, and writes down what it was asked."""

    def __init__(self, name, languages, cloning=False, vram_gb=None, ram_gb=0.5, options=(), installed=True,
                 rate=24000, per_language=False, speaks_all=False, load_delay=0.0, fail=None, on_load=None):
        super().__init__()
        self.name = name
        self.languages = tuple(languages)
        self.supports_cloning = cloning
        self.vram_gb = vram_gb
        self.ram_gb = ram_gb
        self.options = frozenset(options)
        self.installed = installed
        self.sample_rate = rate
        self.per_language = per_language
        self.speaks_all = speaks_all
        self.load_delay = load_delay
        self.fail = fail
        self.on_load = on_load
        self.models = set()
        self.loads = []
        self.calls = []

    def available(self):
        return self.installed

    def speaks(self, language):
        return self.speaks_all or language in self.languages

    def loaded(self, language=None):
        if not self.per_language or language is None:
            return bool(self.models)
        return language in self.models

    def load(self, device, language=None):
        self.loads.append((device, language))
        if self.load_delay:
            time.sleep(self.load_delay)
        if self.fail:
            raise RuntimeError(self.fail)
        self.models.add(language if self.per_language else "*")
        self.device = device
        if self.on_load:
            self.on_load(self, device)

    def synthesize(self, text, language, voice, options):
        self.calls.append({"text": text, "language": language, "voice": voice, "options": dict(options)})
        return PCM, self.sample_rate


def trio(**changes):
    """Fakes with the real engines' languages, cloning, memory needs and options; `changes` sets attributes
    per engine, e.g. trio(freya={"installed": False})."""
    engines = {
        "chatterbox": FakeEngine("chatterbox", ve.CHATTERBOX_LANGUAGES, cloning=True, vram_gb=4.0, ram_gb=6.5,
                                 options=server.ChatterboxEngine.options, speaks_all=True),
        "freya": FakeEngine("freya", ve.FREYA_LANGUAGES, vram_gb=2.0, ram_gb=2.5, options=ve.FreyaEngine.options, rate=48000),
        "pocket": FakeEngine("pocket", ve.POCKET_LANGUAGES, cloning=True, ram_gb=1.0, options=ve.PocketEngine.options,
                             per_language=True),
    }
    for name, attributes in changes.items():
        for key, value in attributes.items():
            setattr(engines[name], key, value)
    return engines


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def voices(engines=None, logs=None, vram=None, ram=None, **kwargs):
    engines = engines or trio()
    return ve.VoiceEngines(
        list(engines.values()),
        free_vram=vram if callable(vram) else (lambda device: vram),
        free_ram=ram if callable(ram) else (lambda: ram),
        log=(logs.append if logs is not None else None),
        **kwargs,
    )


def spoken(registry, language, **fields):
    """The engine that answers one line (and its sample rate)."""
    _pcm, rate, name = registry.synthesize({"text": "Merhaba.", "language_id": language, **fields})
    return name, rate


def spec_route(language, cloning, usable, pocket_clones):
    """The routing as the task states it, sentence by sentence, written apart from auto_route."""
    if cloning:
        # "a request for voice cloning on a language pocket covers goes to pocket (it clones), otherwise chatterbox"
        if language in POCKET and "pocket" in usable and pocket_clones:
            return "pocket"
        if "chatterbox" in usable:
            return "chatterbox"
    if language == "tr":  # "tr -> freya if available else chatterbox"
        order = ["freya", "chatterbox"]
    elif language in POCKET:  # "en/fr/de/it/pt/es/nl -> pocket if available else chatterbox"
        order = ["pocket", "chatterbox"]
    else:  # "any other language -> chatterbox"
        order = ["chatterbox"]
    return next((name for name in order if name in usable), None)


class QuietTest(unittest.TestCase):
    """The server prints what it does; the tests keep it out of their own output."""

    def setUp(self):
        for stream in (contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO())):
            stream.__enter__()
            self.addCleanup(stream.__exit__, None, None, None)


# ---------------------------------------------------------------- routing


class RoutingTest(unittest.TestCase):
    def test_the_table_row_by_row(self):
        everything = {"chatterbox", "freya", "pocket"}
        rows = [
            ("tr", False, everything, True, "freya"),
            ("tr", False, {"chatterbox", "pocket"}, True, "chatterbox"),
            ("tr", False, {"pocket"}, True, None),
            ("en", False, everything, True, "pocket"),
            ("nl", False, {"chatterbox", "freya"}, True, "chatterbox"),
            ("ru", False, everything, True, "chatterbox"),
            ("ru", False, {"freya", "pocket"}, True, None),
            ("en", True, everything, True, "pocket"),
            ("en", True, everything, False, "chatterbox"),
            ("tr", True, everything, True, "chatterbox"),
            ("tr", True, {"freya", "pocket"}, True, "freya"),  # nothing clones Turkish: the words still go out
            ("de", True, {"pocket"}, False, "pocket"),
            ("ja", True, {"freya", "pocket"}, True, None),
        ]
        for language, cloning, usable, pocket_clones, expected in rows:
            with self.subTest(language=language, cloning=cloning, usable=sorted(usable), pocket_clones=pocket_clones):
                got = ve.auto_route(language, cloning, usable.__contains__, lambda name: name != "pocket" or pocket_clones)
                self.assertEqual(got, expected)

    def test_every_language_engine_and_voice_combination(self):
        languages = ["tr", *ve.POCKET_LANGUAGES, "ru", "ja", "ar", "xx"]
        subsets = [set(), {"chatterbox"}, {"freya"}, {"pocket"}, {"chatterbox", "freya"}, {"chatterbox", "pocket"},
                   {"freya", "pocket"}, {"chatterbox", "freya", "pocket"}]
        for language in languages:
            for cloning in (False, True):
                for usable in subsets:
                    for pocket_clones in (True, False):
                        with self.subTest(language=language, cloning=cloning, usable=sorted(usable), pocket_clones=pocket_clones):
                            got = ve.auto_route(language, cloning, usable.__contains__,
                                                lambda name: name != "pocket" or pocket_clones)
                            self.assertEqual(got, spec_route(language, cloning, usable, pocket_clones))

    def test_the_registry_routes_the_same_way_and_says_so_in_x_engine(self):
        registry = voices()
        self.assertEqual(spoken(registry, "tr"), ("freya", 48000))
        self.assertEqual(spoken(registry, "en"), ("pocket", 24000))
        self.assertEqual(spoken(registry, "ja"), ("chatterbox", 24000))
        with tempfile.TemporaryDirectory() as folder:
            ref = os.path.join(folder, "ref.wav")
            Path(ref).write_bytes(b"RIFF")
            self.assertEqual(spoken(registry, "fr", voice_ref=ref)[0], "pocket")
            self.assertEqual(spoken(registry, "tr", voice_ref=ref)[0], "chatterbox")
            # The engine that clones gets the checked path; one that cannot is not handed it at all.
            self.assertEqual(registry.engines["chatterbox"].calls[-1]["voice"], os.path.realpath(ref))
            self.assertEqual(spoken(registry, "tr", voice_ref=ref, engine="freya")[0], "freya")
            self.assertIsNone(registry.engines["freya"].calls[-1]["voice"])

    def test_languages_are_read_as_codes(self):
        registry = voices()
        self.assertEqual(spoken(registry, "TR-tr")[0], "freya")
        self.assertEqual(spoken(registry, "pt_BR")[0], "pocket")
        self.assertEqual(spoken(registry, "")[0], "freya", "no language has always meant Turkish")
        for bad in ("english", "e1", "../x"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                spoken(registry, bad)

    def test_engines_limits_what_may_load_and_what_auto_can_pick(self):
        registry = voices(enabled=["freya", "pocket"])
        self.assertEqual(spoken(registry, "tr")[0], "freya")
        self.assertEqual(spoken(registry, "en")[0], "pocket")
        with self.assertRaisesRegex(ve.EngineUnavailable, "no enabled, installed engine speaks 'ru'"):
            spoken(registry, "ru")
        with self.assertRaisesRegex(ve.EngineUnavailable, r"not enabled on this server \(--engines freya,pocket\)"):
            spoken(registry, "ja", engine="chatterbox")
        self.assertEqual(registry.engines["chatterbox"].loads, [], "an engine left out of --engines never loads")
        only_freya = voices(enabled=["freya"])
        with self.assertRaises(ve.EngineUnavailable):
            spoken(only_freya, "en")

    def test_an_engine_that_is_not_installed_is_skipped_by_auto_and_refused_by_name(self):
        registry = voices(trio(freya={"installed": False}, pocket={"installed": False}))
        self.assertEqual(spoken(registry, "tr")[0], "chatterbox")
        self.assertEqual(spoken(registry, "en")[0], "chatterbox")
        with self.assertRaisesRegex(ve.EngineUnavailable, "the pocket engine is not installed"):
            spoken(registry, "en", engine="pocket")
        nothing = voices(trio(chatterbox={"installed": False}, freya={"installed": False}, pocket={"installed": False}))
        with self.assertRaises(ve.EngineUnavailable):
            spoken(nothing, "tr")

    def test_a_named_engine_is_taken_as_named_or_refused(self):
        registry = voices()
        self.assertEqual(spoken(registry, "ja", engine="chatterbox")[0], "chatterbox")
        self.assertEqual(spoken(registry, "tr", engine=" Chatterbox ")[0], "chatterbox")
        self.assertEqual(spoken(registry, "tr", engine="auto")[0], "freya")
        with self.assertRaisesRegex(ValueError, "does not speak 'en'"):
            spoken(registry, "en", engine="freya")
        with self.assertRaisesRegex(ValueError, "does not speak 'tr'"):
            spoken(registry, "tr", engine="pocket")
        with self.assertRaisesRegex(ValueError, "unknown engine 'espeak'"):
            spoken(registry, "tr", engine="espeak")
        with self.assertRaisesRegex(ValueError, "engine must be a string"):
            spoken(registry, "tr", engine=["freya"])

    def test_a_fixed_default_answers_the_requests_that_name_none(self):
        registry = voices(default="pocket")
        self.assertEqual(spoken(registry, "en")[0], "pocket")
        self.assertEqual(spoken(registry, "en", engine="auto")[0], "pocket")
        self.assertEqual(spoken(registry, "tr", engine="freya")[0], "freya")
        with self.assertRaises(ValueError):
            spoken(registry, "tr")

    def test_pocket_without_its_cloning_weights_hands_the_voice_to_chatterbox(self):
        def no_cloning(engine, device):
            engine.supports_cloning = False

        registry = voices(trio(pocket={"on_load": no_cloning}))
        with tempfile.TemporaryDirectory() as folder:
            ref = os.path.join(folder, "ref.wav")
            Path(ref).write_bytes(b"RIFF")
            self.assertEqual(spoken(registry, "en", voice_ref=ref)[0], "chatterbox", "rerouted once the load showed it")
            self.assertEqual(registry.health()["routing_voice"]["en"], "chatterbox")
            self.assertEqual(spoken(registry, "en")[0], "pocket", "without a voice it still speaks English")
            alone = voices(trio(pocket={"on_load": no_cloning}, chatterbox={"installed": False}))
            self.assertEqual(spoken(alone, "en", voice_ref=ref)[0], "pocket")
            self.assertIsNone(alone.engines["pocket"].calls[-1]["voice"], "its own voice, not a failed clone")


# ---------------------------------------------------------------- where each engine loads


def fake_torch(free_bytes=3.5e9, cuda=True, fail=False):
    calls = []

    def mem_get_info(*index):
        calls.append(index)
        if fail:
            raise RuntimeError("CUDA error")
        return free_bytes, 8e9

    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: cuda, mem_get_info=mem_get_info)
    torch.seeds = []
    torch.manual_seed = torch.seeds.append
    return torch, calls


class DeviceTest(unittest.TestCase):
    def test_choose_device(self):
        self.assertEqual(ve.choose_device("cuda", 2.0, 5.0), "cuda")
        self.assertEqual(ve.choose_device("cuda", 2.0, 2.0), "cuda")
        self.assertEqual(ve.choose_device("cuda", 2.0, 1.9), "cpu")
        self.assertEqual(ve.choose_device("cuda", 2.0, None), "cpu", "an unknown figure is not enough")
        self.assertEqual(ve.choose_device("cuda", None, 24.0), "cpu", "pocket stays on the CPU")
        self.assertEqual(ve.choose_device("cpu", 2.0, 24.0), "cpu", "--device cpu keeps everything there")
        self.assertEqual(ve.choose_device("cuda:1", 4.0, 6.0), "cuda:1")
        self.assertEqual(ve.choose_device("mps", 4.0, None), "mps")

    def test_cuda_free_gb_reads_mem_get_info(self):
        torch, calls = fake_torch(free_bytes=3.5e9)
        with mock.patch.dict(sys.modules, {"torch": torch}):
            self.assertAlmostEqual(ve.cuda_free_gb("cuda"), 3.5)
            self.assertAlmostEqual(ve.cuda_free_gb("cuda:1"), 3.5)
        self.assertEqual(calls, [(), (1,)])
        for broken in (fake_torch(cuda=False)[0], fake_torch(fail=True)[0]):
            with mock.patch.dict(sys.modules, {"torch": broken}):
                self.assertIsNone(ve.cuda_free_gb("cuda"))
        with mock.patch.dict(sys.modules, {"torch": None}):
            self.assertIsNone(ve.cuda_free_gb("cuda"), "no torch at all")

    def test_a_second_engine_goes_to_the_cpu_when_the_first_leaves_too_little_vram(self):
        card = {"free": 5.0}

        def take_vram(engine, device):
            if device.startswith("cuda"):
                card["free"] -= engine.vram_gb

        engines = trio(chatterbox={"on_load": take_vram}, freya={"on_load": take_vram})
        registry = voices(engines, device="cuda", vram=lambda device: card["free"], ram=64.0)
        self.assertEqual(spoken(registry, "ja")[0], "chatterbox")
        self.assertEqual(spoken(registry, "tr")[0], "freya")
        self.assertEqual(spoken(registry, "en")[0], "pocket")
        self.assertEqual([load[0] for load in engines["chatterbox"].loads], ["cuda"])
        self.assertEqual([load[0] for load in engines["freya"].loads], ["cpu"], "1 GB left, it needs 2")
        self.assertEqual([load[0] for load in engines["pocket"].loads], ["cpu"])
        report = registry.health()["engines"]
        self.assertEqual(report["chatterbox"]["device"], "cuda")
        self.assertIn("5.0 GB of VRAM free", report["chatterbox"]["placement"])
        self.assertEqual(report["freya"]["device"], "cpu")
        self.assertIn("1.0 GB of VRAM free, it needs ~2.0 GB: not enough", report["freya"]["placement"])
        self.assertEqual(report["pocket"]["placement"], "made for the CPU")

    def test_the_other_order_fits_both_on_the_card(self):
        card = {"free": 6.5}

        def take_vram(engine, device):
            if device.startswith("cuda"):
                card["free"] -= engine.vram_gb

        engines = trio(chatterbox={"on_load": take_vram}, freya={"on_load": take_vram})
        registry = voices(engines, device="cuda", vram=lambda device: card["free"], ram=64.0)
        spoken(registry, "tr")
        spoken(registry, "ja")
        self.assertEqual((engines["freya"].device, engines["chatterbox"].device), ("cuda", "cuda"))

    def test_device_cpu_keeps_every_engine_there(self):
        engines = trio()
        registry = voices(engines, device="cpu", vram=24.0, ram=64.0)
        for language in ("tr", "en", "ja"):
            spoken(registry, language)
        self.assertEqual({engine.device for engine in engines.values()}, {"cpu"})


class MemoryTest(QuietTest):
    def test_a_second_engine_is_not_loaded_into_ram_that_is_not_there(self):
        logs = []
        clock = Clock()
        memory = {"free": 2.0}
        registry = voices(logs=logs, ram=lambda: memory["free"], clock=clock)
        # Alone, a load that may not fit is only warned about: there is nothing to protect yet.
        self.assertEqual(spoken(registry, "ja")[0], "chatterbox")
        self.assertTrue(any("WARNING: chatterbox wants ~6.5 GB" in line for line in logs), logs)
        # Next to it, it is refused, and Turkish goes to the engine that is already loaded.
        self.assertEqual(spoken(registry, "tr")[0], "chatterbox")
        self.assertEqual(registry.engines["freya"].loads, [], "refused before it could start")
        self.assertIn("not enough memory to load freya next to chatterbox", registry.health()["engines"]["freya"]["error"])
        self.assertEqual(registry.health()["routing"]["tr"], "chatterbox")
        clock.now += ve.LOAD_RETRY_SECONDS + 1
        memory["free"] = 4.0
        self.assertEqual(spoken(registry, "tr")[0], "freya", "tried again once the minute is up")
        self.assertIsNone(registry.health()["engines"]["freya"]["error"])


class LoadingTest(QuietTest):
    def test_nothing_loads_before_it_is_needed(self):
        engines = trio()
        registry = voices(engines)
        self.assertEqual([engine.loads for engine in engines.values()], [[], [], []])
        self.assertFalse(any(entry["loaded"] for entry in registry.health()["engines"].values()))
        spoken(registry, "tr")
        self.assertEqual((engines["freya"].loads, engines["chatterbox"].loads, engines["pocket"].loads), ([("cpu", "tr")], [], []))

    def test_concurrent_requests_wait_for_one_load(self):
        engines = trio(freya={"load_delay": 0.2})
        registry = voices(engines)
        results, errors = [], []

        def speak():
            try:
                results.append(spoken(registry, "tr")[0])
            except Exception as err:  # noqa: BLE001
                errors.append(err)

        threads = [threading.Thread(target=speak) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
        self.assertEqual(errors, [])
        self.assertEqual(results, ["freya"] * 8)
        self.assertEqual(len(engines["freya"].loads), 1)
        self.assertEqual(len(engines["freya"].calls), 8)

    def test_pocket_loads_each_language_it_is_asked_for(self):
        engines = trio()
        registry = voices(engines)
        for language in ("en", "fr", "en"):
            spoken(registry, language)
        self.assertEqual(engines["pocket"].loads, [("cpu", "en"), ("cpu", "fr")])

    def test_a_failed_load_is_left_alone_for_a_minute_while_auto_moves_on(self):
        clock = Clock()
        engines = trio(freya={"fail": "download interrupted"})
        registry = voices(engines, clock=clock)
        self.assertEqual(spoken(registry, "tr")[0], "chatterbox")
        self.assertEqual(spoken(registry, "tr")[0], "chatterbox")
        self.assertEqual(len(engines["freya"].loads), 1, "not retried on every request")
        self.assertEqual(registry.health()["engines"]["freya"]["error"], "download interrupted")
        with self.assertRaisesRegex(ve.EngineUnavailable, "download interrupted"):
            spoken(registry, "tr", engine="freya")
        clock.now += ve.LOAD_RETRY_SECONDS + 1
        engines["freya"].fail = None
        self.assertEqual(spoken(registry, "tr")[0], "freya")
        self.assertEqual(len(engines["freya"].loads), 2)

    def test_a_named_engine_that_fails_to_load_is_an_error_not_a_substitute(self):
        engines = trio(freya={"fail": "out of memory"})
        registry = voices(engines)
        with self.assertRaisesRegex(ve.EngineUnavailable, "the freya engine could not be loaded: out of memory"):
            spoken(registry, "tr", engine="freya")
        self.assertEqual(engines["chatterbox"].calls, [])

    def test_when_everything_fails_the_load_error_is_what_comes_back(self):
        engines = trio(freya={"fail": "no weights"}, chatterbox={"fail": "no CUDA"})
        with self.assertRaisesRegex(ve.EngineUnavailable, "no CUDA"):
            spoken(voices(engines), "tr")

    def test_preload(self):
        engines = trio()
        self.assertEqual(voices(engines).preload("all"), (3, 0))
        self.assertEqual(
            [engines[name].loads for name in ve.ENGINE_NAMES],
            [[("cpu", None)], [("cpu", None)], [("cpu", "en")]],
        )
        engines = trio()
        self.assertEqual(voices(engines, enabled=["freya", "pocket"]).preload("all"), (2, 0))
        self.assertEqual(engines["chatterbox"].loads, [])
        engines = trio(pocket={"installed": False})
        self.assertEqual(voices(engines).preload("all"), (2, 0))
        engines = trio()
        self.assertEqual(voices(engines).preload("tr,fr"), (2, 0))
        self.assertEqual((engines["freya"].loads, engines["pocket"].loads, engines["chatterbox"].loads), ([("cpu", None)], [("cpu", "fr")], []))
        engines = trio()
        self.assertEqual(voices(engines).preload("tr, fr", cloning=True), (2, 0), "a voice to clone: the engines that clone it")
        self.assertEqual((engines["freya"].loads, engines["pocket"].loads, engines["chatterbox"].loads), ([], [("cpu", "fr")], [("cpu", None)]))
        engines = trio()
        self.assertEqual(voices(engines).preload("none"), (0, 0))
        self.assertEqual(voices(engines).preload("tr,??,english"), (1, 0), "a code that is not one is skipped")
        engines = trio(freya={"fail": "broken"})
        self.assertEqual(voices(engines).preload("tr"), (0, 1))


# ---------------------------------------------------------------- tuning fields


class OptionsTest(unittest.TestCase):
    def test_each_engine_gets_the_fields_it_takes_and_nothing_else(self):
        engines = trio()
        registry = voices(engines)
        fields = {"seed": 7, "steps": 16, "temperature": 0.5, "exaggeration": 0.7, "cfg_weight": "0.4",
                  "audio_prompt_path": "/etc/passwd", "top_k": 5, "whatever": {"x": 1}}
        spoken(registry, "tr", **fields)
        spoken(registry, "en", **fields)
        spoken(registry, "ja", **fields)
        self.assertEqual(engines["freya"].calls[-1]["options"], {"seed": 7, "steps": 16})
        self.assertEqual(engines["pocket"].calls[-1]["options"], {"seed": 7, "temperature": 0.5})
        self.assertEqual(engines["chatterbox"].calls[-1]["options"],
                         {"seed": 7, "temperature": 0.5, "exaggeration": 0.7, "cfg_weight": 0.4})

    def test_a_bad_value_is_refused_before_anything_loads(self):
        engines = trio()
        registry = voices(engines)
        bad = [("seed", "abc"), ("seed", True), ("seed", 1.5), ("seed", -1), ("steps", 1000), ("steps", 0),
               ("temperature", float("nan")), ("temperature", float("inf")), ("top_p", 2), ("seed", [1])]
        for key, value in bad:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                spoken(registry, "tr", **{key: value})
        self.assertEqual(engines["freya"].loads, [])
        self.assertEqual(ve.request_options({"seed": "7", "steps": 12.0, "temperature": None}), {"seed": 7, "steps": 12})


# ---------------------------------------------------------------- the real adapters, on fake libraries


class FakePocketModel:
    def __init__(self, language, cloning=True):
        self.language = language
        self.has_voice_cloning = cloning
        self.sample_rate = 24000
        self.temp = 0.3
        self.prompts = []
        self.spoken = []

    def get_state_for_audio_prompt(self, source, truncate=False):
        self.prompts.append((source, truncate))
        return {"voice": source}

    def generate_audio(self, state, text):
        self.spoken.append({"state": state, "text": text, "temp": self.temp})
        return [0.5, -0.5, 2.0]


def fake_pocket_library(cloning=True):
    loaded = []

    def load_model(language=None, **kwargs):
        loaded.append(language)
        return FakePocketModel(language, cloning)

    package = types.ModuleType("pocket_tts")
    package.TTSModel = types.SimpleNamespace(load_model=load_model)
    defaults = types.ModuleType("pocket_tts.default_parameters")
    defaults.get_default_voice_for_language = lambda language, config=None: {"french": "estelle"}.get(language, "alba")
    package.default_parameters = defaults
    return {"pocket_tts": package, "pocket_tts.default_parameters": defaults}, loaded


class AdapterTest(unittest.TestCase):
    def test_to_pcm16(self):
        self.assertEqual(ve.to_pcm16([1.5, -2.0, 0.0, 0.5]), b"\xff\x7f\x01\x80\x00\x00\xff\x3f")

    def test_pocket(self):
        modules, loaded = fake_pocket_library()
        torch, _calls = fake_torch()
        engine = ve.PocketEngine()
        with mock.patch.dict(sys.modules, {**modules, "torch": torch}):
            engine.load("cuda", "fr")
            self.assertEqual((loaded, engine.device, engine.sample_rate), (["french"], "cpu", 24000))
            pcm, rate = engine.synthesize("Bonjour.", "fr", None, {})
            model = engine.models["fr"]
            self.assertEqual(model.prompts, [("estelle", False)], "the language's own voice when none is given")
            self.assertEqual((pcm, rate), (ve.to_pcm16([0.5, -0.5, 2.0]), 24000))
            engine.synthesize("Encore.", "fr", None, {})
            self.assertEqual(len(model.prompts), 1, "a voice is encoded once")
            engine.synthesize("Bonjour.", "fr", "/voices/ref.wav", {"temperature": 0.9, "seed": 7})
            source, truncate = model.prompts[-1]
            self.assertIsInstance(source, Path, "a Path is read as a file; a string could be taken for a URL")
            self.assertEqual((str(source), truncate), (str(Path("/voices/ref.wav")), True))
            self.assertEqual(model.spoken[-1]["temp"], 0.9)
            self.assertEqual(model.temp, 0.3, "the temperature is put back for the next request")
            self.assertEqual(torch.seeds, [7])
            engine.load("cpu", "en")
            engine.load("cpu", "de")
            self.assertEqual(list(engine.models), ["en", "de"], "two languages kept, the oldest dropped")
            self.assertFalse(any(key[0] == "fr" for key in engine.voices))

    def test_pocket_without_the_cloning_weights(self):
        modules, _loaded = fake_pocket_library(cloning=False)
        engine = ve.PocketEngine()
        with mock.patch.dict(sys.modules, modules):
            engine.load("cpu", "en")
            self.assertFalse(engine.supports_cloning)
            engine.synthesize("Hello.", "en", "/voices/ref.wav", {})
            self.assertEqual(engine.models["en"].prompts, [("alba", False)])

    def test_freya(self):
        calls = []

        class FakeFreya:
            sample_rate = 48000

            @classmethod
            def from_pretrained(cls, repo, device="cuda"):
                calls.append(("from_pretrained", repo, device))
                return cls()

            def synthesize(self, text, **kwargs):
                calls.append(("synthesize", text, kwargs))
                return [0.25]

        package = types.ModuleType("freyatts")
        package.FreyaTTS = FakeFreya
        engine = ve.FreyaEngine()
        with mock.patch.dict(sys.modules, {"freyatts": package}):
            engine.load("cuda", "tr")
        self.assertEqual(calls[0], ("from_pretrained", "freyavoice/freya-tts", "cuda"))
        self.assertEqual((engine.device, engine.sample_rate), ("cuda", 48000))
        self.assertEqual(engine.synthesize("Merhaba.", "tr", "/voices/ref.wav", {}), (ve.to_pcm16([0.25]), 48000))
        self.assertEqual(calls[-1], ("synthesize", "Merhaba.", {}), "its own steps and seed (the Leyla voice) by default")
        engine.synthesize("Merhaba.", "tr", None, {"steps": 16, "seed": 3})
        self.assertEqual(calls[-1], ("synthesize", "Merhaba.", {"steps": 16, "seed": 3}))

    def test_chatterbox(self):
        class FakeChatterbox:
            sr = 24000

            def __init__(self):
                self.calls = []

            def generate(self, text, language_id=None, audio_prompt_path=None, exaggeration=0.5, cfg_weight=0.5, temperature=0.8):
                self.calls.append({"text": text, "language_id": language_id, "audio_prompt_path": audio_prompt_path,
                                   "exaggeration": exaggeration, "cfg_weight": cfg_weight, "temperature": temperature})
                return [0.1]

        torch, _calls = fake_torch()
        engine = server.ChatterboxEngine("multilingual")
        engine.model = FakeChatterbox()
        with mock.patch.dict(sys.modules, {"torch": torch}):
            pcm, rate = engine.synthesize("Merhaba.", "tr", "/voices/ref.wav",
                                          {"exaggeration": 0.7, "temperature": 0.4, "top_p": 0.9, "seed": 5})
        self.assertEqual((pcm, rate), (ve.to_pcm16([0.1]), 24000))
        self.assertEqual(engine.model.calls[-1], {"text": "Merhaba.", "language_id": "tr", "audio_prompt_path": "/voices/ref.wav",
                                                  "exaggeration": 0.7, "cfg_weight": 0.5, "temperature": 0.4})
        self.assertEqual(torch.seeds, [5])
        self.assertTrue(engine.speaks("ja"), "the catch-all")
        turbo = server.ChatterboxEngine("turbo")
        self.assertEqual((turbo.languages, turbo.ram_gb), (("en",), 3.0))
        turbo.model = FakeChatterbox()
        turbo.synthesize("Hello.", "en", None, {})
        self.assertIsNone(turbo.model.calls[-1]["language_id"], "only the multilingual model takes a language")
        with mock.patch.object(server, "accepted_params", return_value=set()):
            engine.synthesize("Merhaba.", "tr", None, {"exaggeration": 0.9, "temperature": 0.2})
        self.assertEqual((engine.model.calls[-1]["exaggeration"], engine.model.calls[-1]["temperature"]), (0.9, 0.8),
                         "with no signature to read, only what it always took")


# ---------------------------------------------------------------- the command line


class ArgumentsTest(QuietTest):
    def test_engine_lists(self):
        self.assertEqual(ve.parse_engine_list("pocket, FREYA"), ["freya", "pocket"])
        self.assertEqual(ve.parse_engine_list(""), list(ve.ENGINE_NAMES))
        self.assertEqual(ve.parse_engine_list("all"), list(ve.ENGINE_NAMES))
        with self.assertRaisesRegex(ValueError, "espeak"):
            ve.parse_engine_list("freya,espeak")

    def test_flags(self):
        args = server.parse_args(["--device", "cpu"])
        self.assertEqual((args.tts_engine, args.engines, args.preload, args.model, args.port), ("auto", list(ve.ENGINE_NAMES), "all", "multilingual", 8020))
        args = server.parse_args(["--device", "cpu", "--engines", "freya,pocket", "--tts-engine", "freya", "--preload", "tr"])
        self.assertEqual((args.engines, args.tts_engine, args.preload), (["freya", "pocket"], "freya", "tr"))
        registry = server.build_voices(args, free_vram=lambda device: None, free_ram=lambda: None)
        self.assertEqual((registry.enabled, registry.default), ({"freya", "pocket"}, "freya"))
        self.assertIsInstance(registry.engines["chatterbox"], server.ChatterboxEngine)
        for bad in (["--engines", "espeak"], ["--tts-engine", "chatterbox", "--engines", "freya"], ["--tts-engine", "espeak"]):
            with self.subTest(bad=bad), self.assertRaises(SystemExit):
                server.parse_args(["--device", "cpu", *bad])


# ---------------------------------------------------------------- the HTTP server


class ServerTest(QuietTest):
    TOKEN = "launch-token"

    def setUp(self):
        super().setUp()
        saved = dict(server.STATE)
        self.addCleanup(lambda: (server.STATE.clear(), server.STATE.update(saved)))
        self.engines = trio()
        self.registry = voices(self.engines)
        server.STATE.update(status="ready", voices=self.registry, voice_ref=None, stt=None, stt_name=None, sr=24000,
                            kind="multilingual", device="cpu", stop=threading.Event())
        server.STATE.pop("load_error", None)
        self.httpd = server.QuietServer(("127.0.0.1", 0), server.Handler)
        self.httpd.quiet = True
        self.httpd.daemon_threads = True
        self.httpd.allowed_hosts = server.allowed_host_names("127.0.0.1")
        self.httpd.token = self.TOKEN.encode("utf-8")
        thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.port = self.httpd.server_address[1]
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)

    def request(self, method, path, body=None, host=None, token=TOKEN, content_type="application/json", headers=None, length=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        if host != "-":  # "-": no Host header at all
            connection.putheader("Host", host or f"127.0.0.1:{self.port}")
        if token is not None:
            connection.putheader(server.TOKEN_HEADER, token)
        data = body if isinstance(body, bytes) else (json.dumps(body).encode("utf-8") if body is not None else b"")
        if content_type is not None and method == "POST":
            connection.putheader("Content-Type", content_type)
        if method == "POST":
            connection.putheader("Content-Length", str(length if length is not None else len(data)))
        for key, value in (headers or {}).items():
            connection.putheader(key, value)
        connection.endheaders(data if method == "POST" else None)
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response.status, {key.lower(): value for key, value in response.getheaders()}, payload

    def audio_file(self, name="ref.wav"):
        path = os.path.join(self.folder.name, name)
        Path(path).write_bytes(b"RIFF....WAVE")
        return path

    def nothing_happened(self):
        self.assertEqual([engine.loads for engine in self.engines.values()], [[], [], []])
        self.assertEqual([engine.calls for engine in self.engines.values()], [[], [], []])
        self.assertIsNone(server.STATE["voice_ref"])
        self.assertFalse(server.STATE["stop"].is_set())

    def test_health_keeps_its_fields_and_adds_the_engines(self):
        status, headers, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        info = json.loads(body)
        for key, value in {"ok": True, "status": "ready", "model": "multilingual", "sr": 24000, "device": "cpu",
                           "voice": None, "stt": None, "error": None, "engine": "auto"}.items():
            self.assertEqual(info[key], value, key)
        self.assertEqual(set(info["engines"]), set(ve.ENGINE_NAMES))
        for name, entry in info["engines"].items():
            self.assertEqual(set(entry), {"available", "enabled", "loaded", "device", "placement", "languages", "cloning",
                                          "sample_rate", "error", "notes"}, name)
        self.assertEqual(info["engines"]["freya"]["languages"], ["tr"])
        self.assertEqual(info["engines"]["freya"]["sample_rate"], 48000)
        self.assertEqual(info["routing"], {"tr": "freya", "en": "pocket", "fr": "pocket", "de": "pocket", "it": "pocket",
                                           "pt": "pocket", "es": "pocket", "nl": "pocket", "*": "chatterbox"})
        self.assertEqual(info["routing_voice"]["tr"], "chatterbox")
        self.assertEqual(info["routing_voice"]["en"], "pocket")
        self.request("POST", "/tts", {"text": "Merhaba.", "language_id": "tr"})
        info = json.loads(self.request("GET", "/health")[2])
        self.assertEqual((info["engines"]["freya"]["loaded"], info["engines"]["freya"]["device"]), (True, "cpu"))
        server.STATE["status"] = "loading"
        info = json.loads(self.request("GET", "/health")[2])
        self.assertEqual((info["ok"], info["status"]), (False, "loading"))

    def test_tts_answers_with_the_pcm_and_says_which_engine_and_rate(self):
        status, headers, body = self.request("POST", "/tts", {"text": "Merhaba.", "language_id": "tr"})
        self.assertEqual(status, 200)
        self.assertEqual(body, PCM)
        self.assertEqual(headers["content-type"], "application/octet-stream")
        self.assertEqual((headers["x-engine"], headers["x-sample-rate"], headers["x-channels"]), ("freya", "48000", "1"))
        status, headers, _body = self.request("POST", "/tts", {"text": "Hello.", "language_id": "en"})
        self.assertEqual((status, headers["x-engine"], headers["x-sample-rate"]), (200, "pocket", "24000"))
        status, headers, _body = self.request("POST", "/tts", {"text": "Merhaba.", "language_id": "tr", "engine": "chatterbox", "seed": 3})
        self.assertEqual((status, headers["x-engine"]), (200, "chatterbox"))
        self.assertEqual(self.engines["chatterbox"].calls[-1]["options"], {"seed": 3})

    def test_tts_errors(self):
        cases = [
            ({"text": "  "}, 400, "text is empty"),
            ({"text": "x", "engine": "espeak"}, 400, "unknown engine"),
            ({"text": "x", "language_id": "en", "engine": "freya"}, 400, "does not speak"),
            ({"text": "x", "seed": "many"}, 400, "seed must be a number"),
        ]
        for payload, expected, message in cases:
            with self.subTest(payload=payload):
                status, _headers, body = self.request("POST", "/tts", payload)
                self.assertEqual(status, expected)
                self.assertIn(message, json.loads(body)["error"])
        self.registry.enabled.discard("pocket")
        status, _headers, body = self.request("POST", "/tts", {"text": "x", "language_id": "en", "engine": "pocket"})
        self.assertEqual(status, 503)
        self.assertIn("not enabled", json.loads(body)["error"])
        self.nothing_happened()
        server.STATE["status"] = "loading"
        status, _headers, body = self.request("POST", "/tts", {"text": "x"})
        self.assertEqual((status, json.loads(body)["error"]), (503, "the model is not loaded yet"))

    def test_concurrent_requests_load_the_engine_once(self):
        self.engines["freya"].load_delay = 0.3
        results = []

        def speak():
            results.append(self.request("POST", "/tts", {"text": "Merhaba.", "language_id": "tr"})[0])

        threads = [threading.Thread(target=speak) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(15)
        self.assertEqual(results, [200] * 6)
        self.assertEqual(len(self.engines["freya"].loads), 1)

    def test_every_refusal_still_applies_to_every_endpoint(self):
        endpoints = [("GET", "/health", None), ("POST", "/tts", {"text": "Hello.", "language_id": "en", "engine": "pocket"}),
                     ("POST", "/voice", {"voice_ref": self.audio_file()}), ("POST", "/shutdown", {}),
                     ("POST", "/stt", b"\x00\x00" * 160)]
        for method, path, body in endpoints:
            content_type = "application/octet-stream" if path == "/stt" else "application/json"
            refusals = [
                ("a rebinding name", {"host": "evil.example:8020"}, 403, "host not allowed"),
                ("no Host at all", {"host": "-"}, 403, "host not allowed"),
                ("a web page", {"headers": {"Origin": "https://evil.example"}}, 403, "web page"),
                ("no token", {"token": None}, 403, "token"),
                ("a wrong token", {"token": "guess"}, 403, "token"),
            ]
            if method == "POST":
                wrong = "application/json" if path == "/stt" else "text/plain"
                refusals.append(("a body a form could send", {"content_type": wrong}, 415, "content-type"))
            for why, change, expected, message in refusals:
                with self.subTest(endpoint=path, why=why):
                    status, _headers, reply = self.request(method, path, body, **{"content_type": content_type, **change})
                    self.assertEqual(status, expected)
                    self.assertIn(message, json.loads(reply)["error"])
        self.nothing_happened()

    def test_json_bodies_are_checked(self):
        for path in ("/tts", "/voice"):
            with self.subTest(path=path):
                self.assertEqual(self.request("POST", path, b"{", content_type="application/json")[0], 400)
                self.assertEqual(self.request("POST", path, [1, 2])[0], 400)
                self.assertEqual(self.request("POST", path, b"\xff\xfe", content_type="application/json")[0], 400)
                status, _headers, body = self.request("POST", path, b"{}", length=server.MAX_BODY_BYTES + 1)
                self.assertEqual(status, 400)
                self.assertIn("too large", json.loads(body)["error"])
        self.nothing_happened()

    def test_a_voice_to_clone_is_checked_for_pocket_as_for_everything_else(self):
        safetensors = os.path.join(self.folder.name, "voice.safetensors")
        Path(safetensors).write_bytes(b"{}")
        directory = os.path.join(self.folder.name, "folder.wav")
        os.mkdir(directory)
        bad = [os.path.abspath(__file__), os.path.join(self.folder.name, "missing.wav"), "https://example.com/voice.wav",
               "hf://kyutai/tts-voices/alba-mackenna/casual.wav", safetensors, directory, 42, ["ref.wav"]]
        for value in bad:
            for path, payload in (("/tts", {"text": "Hello.", "language_id": "en", "engine": "pocket", "voice_ref": value}),
                                  ("/tts", {"text": "Hello.", "language_id": "en", "voice_ref": value}),
                                  ("/voice", {"voice_ref": value})):
                with self.subTest(path=path, value=value):
                    status, _headers, body = self.request("POST", path, payload)
                    self.assertEqual(status, 400)
                    self.assertIn("voice_ref must be", json.loads(body)["error"])
        self.nothing_happened()
        ref = self.audio_file()
        status, headers, _body = self.request("POST", "/tts", {"text": "Hello.", "language_id": "en", "voice_ref": ref})
        self.assertEqual((status, headers["x-engine"]), (200, "pocket"))
        self.assertEqual(self.engines["pocket"].calls[-1]["voice"], os.path.realpath(ref))

    def test_the_default_voice_is_cloned_by_the_engine_that_can(self):
        ref = self.audio_file("owner.flac")
        status, _headers, body = self.request("POST", "/voice", {"voice_ref": ref})
        self.assertEqual((status, json.loads(body)["voice"]), (200, os.path.realpath(ref)))
        status, headers, _body = self.request("POST", "/tts", {"text": "Hello.", "language_id": "en"})
        self.assertEqual((status, headers["x-engine"]), (200, "pocket"))
        self.assertEqual(self.engines["pocket"].calls[-1]["voice"], os.path.realpath(ref))
        status, headers, _body = self.request("POST", "/tts", {"text": "Merhaba.", "language_id": "tr"})
        self.assertEqual(headers["x-engine"], "chatterbox", "Freya cannot clone, Chatterbox can")
        self.assertEqual(json.loads(self.request("GET", "/health")[2])["voice"], os.path.realpath(ref))
        self.assertEqual(self.request("POST", "/voice", {"voice_ref": None})[0], 200)
        self.assertEqual(self.request("POST", "/tts", {"text": "Merhaba.", "language_id": "tr"})[1]["x-engine"], "freya")

    def test_stt_is_as_it_was(self):
        status, _headers, body = self.request("POST", "/stt", b"\x00\x00" * 160, content_type="application/octet-stream")
        self.assertEqual(status, 503)
        self.assertIn("--stt", json.loads(body)["error"])

    def test_unknown_paths_and_shutdown(self):
        self.assertEqual(self.request("GET", "/nope")[0], 404)
        self.assertEqual(self.request("POST", "/nope", {})[0], 404)
        status, _headers, _body = self.request("POST", "/shutdown", {})
        self.assertEqual(status, 200)
        self.assertTrue(server.STATE["stop"].wait(5))


class MainTest(QuietTest):
    """main() as the bot runs it, with the engines swapped for fakes."""

    def setUp(self):
        super().setUp()
        saved = dict(server.STATE)
        self.addCleanup(lambda: (server.STATE.clear(), server.STATE.update(saved)))
        server.STATE.update(stop=threading.Event(), voices=None, status="loading", voice_ref=None, stt=None)
        server.STATE.pop("load_error", None)

    def command_line(self, *flags):
        """A free port, and the command line main() reads with it."""
        with contextlib.closing(socket.socket()) as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        return port, ["chatterbox_server.py", "--port", str(port), "--device", "cpu", "--token", "t0k3n", *flags]

    def test_it_preloads_reports_ready_and_shuts_down(self):
        engines = trio()
        port, argv = self.command_line("--preload", "tr", "--engines", "freya,pocket")

        def build(args):
            return ve.VoiceEngines(list(engines.values()), enabled=args.engines, default=args.tts_engine, device=args.device,
                                   free_vram=lambda device: None, free_ram=lambda: None)

        with mock.patch.object(sys, "argv", argv), mock.patch.object(server, "build_voices", build):
            thread = threading.Thread(target=server.main, daemon=True)
            thread.start()
            deadline = time.monotonic() + 10
            while server.STATE["status"] != "ready" and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertEqual(server.STATE["status"], "ready")
            self.assertEqual(engines["freya"].loads, [("cpu", None)], "the language it was told to preload")
            self.assertEqual((engines["pocket"].loads, engines["chatterbox"].loads), ([], []))
            self.assertEqual(server.STATE["sr"], 48000)
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            connection.request("GET", "/health", headers={server.TOKEN_HEADER: "t0k3n"})
            info = json.loads(connection.getresponse().read())
            self.assertEqual((info["ok"], info["engine"], info["engines"]["chatterbox"]["enabled"]), (True, "auto", False))
            connection.request("POST", "/shutdown", body=b"{}", headers={server.TOKEN_HEADER: "t0k3n", "Content-Type": "application/json"})
            self.assertEqual(connection.getresponse().status, 200)
            connection.close()
            thread.join(10)
            self.assertFalse(thread.is_alive())

    def test_with_nothing_that_can_speak_it_exits_as_it_always_did(self):
        engines = trio(chatterbox={"installed": False}, freya={"installed": False}, pocket={"installed": False})
        _port, argv = self.command_line()

        def build(args):
            return ve.VoiceEngines(list(engines.values()), enabled=args.engines, default=args.tts_engine, device=args.device)

        with mock.patch.object(sys, "argv", argv), mock.patch.object(server, "build_voices", build):
            with self.assertRaises(SystemExit) as exited:
                server.main()
        self.assertEqual(exited.exception.code, 1)
        self.assertEqual(server.STATE["status"], "error")
        self.assertIn("no speech engine could be loaded", server.STATE["load_error"])


if __name__ == "__main__":
    unittest.main()
