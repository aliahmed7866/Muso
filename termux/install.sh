#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v pkg >/dev/null || { printf 'Run this installer inside Termux.\n' >&2; exit 1; }
pkg install -y python ffmpeg nodejs-lts curl
python -m venv "$repo/.venv"
"$repo/.venv/bin/python" -m pip install -U -r "$repo/requirements.txt"
mkdir -p "$HOME/bin"
printf '#!%s/bin/bash\nexec %q %q "$@"\n' "$PREFIX" "$PREFIX/bin/bash" "$repo/termux/muso" > "$HOME/bin/muso"
chmod 700 "$HOME/bin/muso"
opener="$HOME/bin/termux-url-opener"
if [[ ! -e "$opener" && ! -L "$opener" ]]; then
  printf '#!%s/bin/bash\nexec %q share "$@"\n' "$PREFIX" "$HOME/bin/muso" > "$opener"
  chmod 700 "$opener"
  printf 'Android sharing is ready. Choose Termux in the share sheet.\n'
else
  printf 'Existing Android share handler left in place. See the README to add Muso routing.\n'
fi
printf 'Start Muso with ~/bin/muso open\n'
