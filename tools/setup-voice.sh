#!/usr/bin/env bash
# Local speech setup (Linux, macOS): the .venv-chatterbox virtual environment with the speech engines.
#   tools/setup-voice.sh [--engines freya,pocket,chatterbox]
# tools/setup-chatterbox.ps1 does the same on Windows. PYTHON=python3.12 picks the interpreter the
# environment is built with (python3 by default).
#
# The engines (any of them, comma-separated):
#   freya       FreyaTTS-small: Turkish, one voice, 48 kHz. ~1.5 GB of VRAM on a GPU, usable on a CPU.
#   pocket      Kyutai Pocket TTS: English, French, German, Italian, Portuguese, Spanish, Dutch. Made for the
#               CPU; clones a voice once its terms are accepted on Hugging Face (see the end of the setup).
#   chatterbox  Chatterbox multilingual (Turkish included), clones a voice. Wants a GPU with ~4 GB free.
# The default, freya,pocket, suits a CPU or a small GPU; add chatterbox for a cloned voice in Turkish and
# for the languages the other two do not speak. faster-whisper (the local ears) is installed in every case.
# The model weights are downloaded from Hugging Face on the first run, not here.

set -euo pipefail

# FreyaTTS is not on PyPI: it comes from its repository, at the commit the server's adapter was written against.
FREYA_REPO="https://github.com/freyavoiceai/FreyaTTS.git"
FREYA_COMMIT="146d36c1cb6660646be57d31339db4eed9315de3"
# The Pocket TTS release the server's adapter was written against.
POCKET_VERSION="3.3.0"

engines="freya,pocket"
while [ $# -gt 0 ]; do
	case "$1" in
		--engines)
			[ $# -ge 2 ] || { echo "--engines needs a value, e.g. --engines freya,pocket" >&2; exit 2; }
			engines="$2"
			shift 2
			;;
		--engines=*)
			engines="${1#*=}"
			shift
			;;
		-h | --help)
			sed -n '2,14p' "$0"
			exit 0
			;;
		*)
			echo "unknown argument: $1 (see --help)" >&2
			exit 2
			;;
	esac
done

# A space-separated list with a space at each end, so that "has freya" is one pattern match.
selected=" "
for name in $(printf '%s' "$engines" | tr ',' ' ' | tr '[:upper:]' '[:lower:]'); do
	case "$name" in
		chatterbox | freya | pocket) selected="$selected$name " ;;
		*)
			echo "unknown engine: $name (known: chatterbox, freya, pocket)" >&2
			exit 2
			;;
	esac
done
has() {
	case "$selected" in *" $1 "*) return 0 ;; esac
	return 1
}
if [ "$selected" = " " ]; then
	echo "no engine given (--engines freya,pocket,chatterbox)" >&2
	exit 2
fi
echo "engines to install:$selected"

# What the graphics card holds decides the torch build and the recommendation.
vram_gb=""
if command -v nvidia-smi >/dev/null 2>&1; then
	mb="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -n 1 | tr -dc '0-9')"
	if [ -n "$mb" ]; then
		vram_gb=$(((mb + 512) / 1024))
	fi
fi
if [ -z "$vram_gb" ]; then
	echo "No NVIDIA GPU found: CPU builds of torch. Recommended: --engines freya,pocket (Chatterbox on a CPU is slow and needs ~6.5 GB of memory)."
elif [ "$vram_gb" -ge 8 ]; then
	echo "NVIDIA GPU, $vram_gb GB of VRAM: FreyaTTS (~2 GB), Chatterbox (~4 GB) and whisper fit side by side. Recommended: --engines freya,pocket,chatterbox"
elif [ "$vram_gb" -ge 4 ]; then
	echo "NVIDIA GPU, $vram_gb GB of VRAM: FreyaTTS and whisper fit; next to them Chatterbox would run on the CPU. Recommended: --engines freya,pocket"
else
	echo "NVIDIA GPU, $vram_gb GB of VRAM: FreyaTTS fits, Chatterbox does not. Recommended: --engines freya,pocket"
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
venv="$root/.venv-chatterbox"
py="$venv/bin/python"
python="${PYTHON:-python3}"
if [ ! -x "$py" ]; then
	echo "creating the virtual environment with $python..."
	"$python" -m venv "$venv"
fi
version="$("$py" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
major="${version%%.*}"
minor="${version#*.}"
if [ "$major" -ne 3 ] || [ "$minor" -lt 10 ] || [ "$minor" -ge 14 ]; then
	echo "Warning: the environment's Python is $version; the engines are built for 3.10-3.13 (PYTHON=python3.12 $0)."
fi
if has chatterbox && has pocket && [ "$minor" -lt 13 ]; then
	echo "Note: on Python $version chatterbox-tts asks for numpy<2 and pocket-tts for numpy>=2; numpy 2 is what ends up installed and pip reports the conflict. If Chatterbox then fails to load, build .venv-chatterbox with Python 3.13 (PYTHON=python3.13), where chatterbox-tts asks for numpy 2 itself."
fi

"$py" -m pip install --upgrade pip --no-cache-dir

# torch first, from the index that matches the machine, so that no engine pulls in a build it cannot use.
# On Linux PyPI's wheels carry CUDA, which is what a GPU wants and 2 GB of dead weight without one; macOS
# takes PyPI's (CPU, and the Apple GPU through MPS). Chatterbox pins torch 2.6.0.
if has chatterbox; then
	torch_spec="torch==2.6.0 torchaudio==2.6.0"
else
	torch_spec="torch torchaudio"
fi
if [ -z "$vram_gb" ] && [ "$(uname -s)" = "Linux" ]; then
	echo "installing $torch_spec (CPU build)..."
	# shellcheck disable=SC2086  # the spec is two words on purpose
	"$py" -m pip install $torch_spec --index-url https://download.pytorch.org/whl/cpu --no-cache-dir
else
	echo "installing $torch_spec..."
	# shellcheck disable=SC2086
	"$py" -m pip install $torch_spec --no-cache-dir
fi

echo "installing faster-whisper (local speech recognition)..."
if [ -n "$vram_gb" ]; then
	"$py" -m pip install faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12 --no-cache-dir
else
	"$py" -m pip install faster-whisper --no-cache-dir
fi

if has chatterbox; then
	echo "installing chatterbox-tts..."
	"$py" -m pip install chatterbox-tts --no-cache-dir
fi

if has pocket; then
	echo "installing pocket-tts $POCKET_VERSION..."
	"$py" -m pip install "pocket-tts==$POCKET_VERSION" --no-cache-dir
fi

if has freya; then
	if ! command -v git >/dev/null 2>&1; then
		echo "FreyaTTS is installed from its git repository and git was not found; install git and run the setup again." >&2
		exit 1
	fi
	freya_dir="$venv/src/FreyaTTS"
	if [ ! -d "$freya_dir/.git" ]; then
		echo "cloning FreyaTTS into $freya_dir..."
		git clone --quiet "$FREYA_REPO" "$freya_dir"
	fi
	git -C "$freya_dir" fetch --quiet origin
	git -C "$freya_dir" -c advice.detachedHead=false checkout --quiet "$FREYA_COMMIT"
	echo "installing the FreyaTTS requirements (einops, librosa, soundfile, voxcpm, ...)..."
	"$py" -m pip install -r "$freya_dir/requirements.txt" --no-cache-dir
	# FreyaTTS is not a package pip can install; a .pth file puts the clone on the environment's import path.
	"$py" -c "import pathlib, sys, sysconfig; pathlib.Path(sysconfig.get_paths()['purelib'], 'freyatts.pth').write_text(sys.argv[1] + '\n')" "$freya_dir"
fi

"$py" "$root/tools/check-chatterbox.py" || true
echo "setup complete. The bot starts the server by itself when it needs it; to run it by hand:"
echo "  $py tools/chatterbox_server.py --port 8020 --stt small"
echo "To keep the server to these engines, put LOCAL_TTS_ENGINES=$(echo $selected | tr ' ' ',') in .env (empty = every installed one)."
if has pocket; then
	echo "Pocket TTS clones a voice only with its gated weights: accept the terms at https://huggingface.co/kyutai/pocket-tts"
	echo "and log in once with: $venv/bin/hf auth login   (without it Pocket speaks in its own voices)"
fi
