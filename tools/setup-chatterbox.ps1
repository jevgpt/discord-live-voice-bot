# Local speech setup (Windows): the .venv-chatterbox virtual environment with the speech engines.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/setup-chatterbox.ps1 [-Engines freya,pocket,chatterbox]
# tools/setup-voice.sh does the same on Linux and macOS.
#
# The engines (any of them, comma-separated):
#   freya       FreyaTTS-small: Turkish, one voice, 48 kHz. ~1.5 GB of VRAM on a GPU, usable on a CPU.
#   pocket      Kyutai Pocket TTS: English, French, German, Italian, Portuguese, Spanish, Dutch. Made for the
#               CPU; clones a voice once its terms are accepted on Hugging Face (see the end of the setup).
#   chatterbox  Chatterbox multilingual (Turkish included), clones a voice. Wants a GPU with ~4 GB free.
# The default, freya,pocket, suits a CPU or a small GPU; add chatterbox for a cloned voice in Turkish and
# for the languages the other two do not speak. faster-whisper (the local ears) is installed in every case.
# The model weights are downloaded from Hugging Face on the first run, not here.

param(
	[string]$Engines = 'freya,pocket'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root '.venv-chatterbox'
$py = Join-Path $venv 'Scripts\python.exe'
# FreyaTTS is not on PyPI: it comes from its repository, at the commit the server's adapter was written against.
$freyaRepo = 'https://github.com/freyavoiceai/FreyaTTS.git'
$freyaCommit = '146d36c1cb6660646be57d31339db4eed9315de3'
# The Pocket TTS release the server's adapter was written against.
$pocketVersion = '3.3.0'

# A failed pip or git call is not an exception in PowerShell. This makes it one, so the setup stops at the
# step that failed instead of carrying on and reporting success over it.
function Invoke-Checked([string]$What, [scriptblock]$Command) {
	& $Command
	if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)" }
}

$known = @('chatterbox', 'freya', 'pocket')
$selected = @($Engines -split '[,\s]+' | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() })
$unknown = @($selected | Where-Object { $known -notcontains $_ })
if ($unknown.Count -gt 0) { throw "Unknown engine: $($unknown -join ', ') (known: $($known -join ', '))" }
if ($selected.Count -eq 0) { throw 'No engine given (-Engines freya,pocket,chatterbox).' }
Write-Host "engines to install: $($selected -join ', ')"

# What the graphics card holds decides the torch build and the recommendation.
$vramGb = $null
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
	$line = & nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null | Select-Object -First 1
	if ($line -and ("$line".Trim() -match '^\d+')) { $vramGb = [math]::Round([double]$Matches[0] / 1024, 1) }
}
if ($null -eq $vramGb) {
	Write-Host 'No NVIDIA GPU found: CPU builds of torch. Recommended: -Engines freya,pocket (Chatterbox on a CPU is slow and needs ~6.5 GB of memory).'
} elseif ($vramGb -ge 8) {
	Write-Host "NVIDIA GPU, $vramGb GB of VRAM: FreyaTTS (~2 GB), Chatterbox (~4 GB) and whisper fit side by side. Recommended: -Engines freya,pocket,chatterbox"
} elseif ($vramGb -ge 4) {
	Write-Host "NVIDIA GPU, $vramGb GB of VRAM: FreyaTTS and whisper fit; next to them Chatterbox would run on the CPU. Recommended: -Engines freya,pocket"
} else {
	Write-Host "NVIDIA GPU, $vramGb GB of VRAM: FreyaTTS fits, Chatterbox does not. Recommended: -Engines freya,pocket"
}

if (-not (Test-Path $py)) {
	$sysPy = (& python -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null)
	if ($sysPy -and ([version]$sysPy -lt [version]'3.10' -or [version]$sysPy -ge [version]'3.14')) {
		Write-Host "Warning: system python is $sysPy; the engines are built for 3.10-3.13 (you can install with py -3.12)."
	}
	Write-Host 'creating the virtual environment...'
	Invoke-Checked 'creating the virtual environment' { python -m venv $venv }
}
$venvPy = (& $py -c "import sys; print('%d.%d' % sys.version_info[:2])").Trim()
if (($selected -contains 'chatterbox') -and ($selected -contains 'pocket') -and ([version]$venvPy -lt [version]'3.13')) {
	Write-Host "Note: on Python $venvPy chatterbox-tts asks for numpy<2 and pocket-tts for numpy>=2; numpy 2 is what ends up installed and pip reports the conflict. If Chatterbox then fails to load, build .venv-chatterbox with Python 3.13, where chatterbox-tts asks for numpy 2 itself."
}

Invoke-Checked 'upgrading pip' { & $py -m pip install --upgrade pip --no-cache-dir }

# torch first, from the index that matches the machine, so that no engine pulls in a build it cannot use:
# the CUDA wheels with an NVIDIA GPU, the CPU ones otherwise. Chatterbox pins torch 2.6.0.
$torchIndex = if ($null -ne $vramGb) { 'https://download.pytorch.org/whl/cu124' } else { 'https://download.pytorch.org/whl/cpu' }
$torchSpec = if ($selected -contains 'chatterbox') { @('torch==2.6.0', 'torchaudio==2.6.0') } else { @('torch', 'torchaudio') }
Write-Host "installing $($torchSpec -join ' ') from $torchIndex..."
Invoke-Checked 'installing torch' { & $py -m pip install @torchSpec --index-url $torchIndex --no-cache-dir }

$whisper = @('faster-whisper')
if ($null -ne $vramGb) { $whisper += @('nvidia-cublas-cu12', 'nvidia-cudnn-cu12') }
Write-Host 'installing faster-whisper (local speech recognition)...'
Invoke-Checked 'installing faster-whisper' { & $py -m pip install @whisper --no-cache-dir }

if ($selected -contains 'chatterbox') {
	Write-Host 'installing chatterbox-tts...'
	Invoke-Checked 'installing chatterbox-tts' { & $py -m pip install chatterbox-tts --no-cache-dir }
}

if ($selected -contains 'pocket') {
	Write-Host "installing pocket-tts $pocketVersion..."
	Invoke-Checked 'installing pocket-tts' { & $py -m pip install "pocket-tts==$pocketVersion" --no-cache-dir }
}

if ($selected -contains 'freya') {
	if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
		throw 'FreyaTTS is installed from its git repository and git was not found. Install Git for Windows (https://git-scm.com/download/win) and run the setup again.'
	}
	$freyaDir = Join-Path $venv 'src\FreyaTTS'
	if (-not (Test-Path (Join-Path $freyaDir '.git'))) {
		Write-Host "cloning FreyaTTS into $freyaDir..."
		Invoke-Checked 'cloning FreyaTTS' { git clone --quiet $freyaRepo $freyaDir }
	}
	Invoke-Checked 'fetching FreyaTTS' { git -C $freyaDir fetch --quiet origin }
	Invoke-Checked "checking out FreyaTTS $freyaCommit" { git -C $freyaDir -c advice.detachedHead=false checkout --quiet $freyaCommit }
	Write-Host 'installing the FreyaTTS requirements (einops, librosa, soundfile, voxcpm, ...)...'
	Invoke-Checked 'installing the FreyaTTS requirements' { & $py -m pip install -r (Join-Path $freyaDir 'requirements.txt') --no-cache-dir }
	# FreyaTTS is not a package pip can install; a .pth file puts the clone on the environment's import path.
	Invoke-Checked 'putting FreyaTTS on the import path' {
		& $py -c "import pathlib, sys, sysconfig; pathlib.Path(sysconfig.get_paths()['purelib'], 'freyatts.pth').write_text(sys.argv[1] + '\n')" $freyaDir
	}
}

if ($null -ne $vramGb) {
	# An engine's own requirements can still swap torch for a CPU build; put the CUDA one back if so.
	$cuda = (& $py -c "import torch; print(torch.cuda.is_available())").Trim()
	if ($cuda -ne 'True') {
		$torchRaw = (& $py -c "import torch; print(torch.__version__)").Trim()
		# PyPI wheels report the version as something like "2.6.0+cpu"; on the CUDA index there is no "+cpu" suffix.
		$torch = $torchRaw -replace '\+.*$', ''
		Write-Host "torch $torchRaw does not see the GPU; replacing it with the CUDA wheels: torch==$torch (stays on CPU when they are missing)"
		& $py -m pip install --force-reinstall "torch==$torch" "torchaudio==$torch" --index-url https://download.pytorch.org/whl/cu124
		if ($LASTEXITCODE -ne 0) {
			Write-Host "Could not install the CUDA wheels (exit code $LASTEXITCODE); continuing on CPU."
		}
	}
}

& $py (Join-Path $PSScriptRoot 'check-chatterbox.py')
Write-Host 'setup complete. The bot starts the server by itself when it needs it; to run it by hand:'
Write-Host '  tools\run-chatterbox.cmd'
Write-Host "To keep the server to these engines, put LOCAL_TTS_ENGINES=$($selected -join ',') in .env (empty = every installed one)."
if ($selected -contains 'pocket') {
	Write-Host 'Pocket TTS clones a voice only with its gated weights: accept the terms at https://huggingface.co/kyutai/pocket-tts'
	Write-Host "and log in once with: $venv\Scripts\hf.exe auth login   (without it Pocket speaks in its own voices)"
}
