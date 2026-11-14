#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v pkg >/dev/null || { printf 'Run this installer inside Termux.\n' >&2; exit 1; }
packages=()
for dependency in python ffmpeg curl; do
  if ! command -v "$dependency" >/dev/null; then
    packages+=("$dependency")
  fi
done
if ! command -v node >/dev/null; then
  packages+=(nodejs-lts)
fi
repair_hint() {
  printf 'Termux dependencies are not ready. Run pkg upgrade, then rerun bash termux/install.sh.\n' >&2
}
if (( ${#packages[@]} )) && ! pkg install -y "${packages[@]}"; then
  repair_hint
  exit 1
fi
if ! python --version || ! ffmpeg -version >/dev/null || ! curl --version >/dev/null || ! node --version; then
  repair_hint
  exit 1
fi
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
