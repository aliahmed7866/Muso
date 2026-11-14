#!/usr/bin/env bash
# Muso's runit service. Never restart the shared daemon or touch other services.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${PREFIX:?Run this command inside Termux.}"
export SVDIR="$PREFIX/var/service"
service="$SVDIR/muso"
config="$service/muso.conf"
if [[ -f "$service/.muso-managed" && -f "$config" ]]; then
  source "$config"
fi
export MUSO_DATA_DIR="${MUSO_DATA_DIR:-${MUSO_SERVICE_DATA_DIR:-$HOME/.local/share/muso}}"
export MUSO_PORT="${MUSO_PORT:-${MUSO_SERVICE_PORT:-8765}}"

managed() {
  [[ -f "$service/.muso-managed" ]] || { printf 'Enable automatic recovery with ~/bin/muso enable\n' >&2; return 1; }
  [[ "${MUSO_SERVICE_REPO:-$repo}" == "$repo" && "${MUSO_SERVICE_DATA_DIR:-$MUSO_DATA_DIR}" == "$MUSO_DATA_DIR" && "${MUSO_SERVICE_PORT:-$MUSO_PORT}" == "$MUSO_PORT" ]] || {
    printf 'Muso service settings differ. Run ~/bin/muso enable with the intended MUSO_PORT and MUSO_DATA_DIR.\n' >&2; return 1;
  }
}
start_daemon() {
  # "start" is safe when already running. "restart" would interrupt other apps.
  service-daemon start >/dev/null 2>&1 || true
  for ((i=0; i<60; i++)); do
    if sv status "$service" >/dev/null 2>&1; then return; fi
    sleep .25
  done
  printf 'Termux service manager is not ready. Reopen Termux and run ~/bin/muso status.\n' >&2
  return 1
}
start_service() {
  managed
  start_daemon
  rm -f "$service/down"
  sv up "$service"
}
stop_service() {
  managed
  touch "$service/down"
  if sv status "$service" >/dev/null 2>&1; then
    sv -w 12 down "$service"
  fi
  "$repo/.venv/bin/python" "$repo/termux/supervise.py" stop
}
install_service() {
  [[ -x "$repo/.venv/bin/python" ]] || { printf 'Run bash termux/install.sh first.\n' >&2; return 1; }
  if [[ -e "$service" && ! -f "$service/.muso-managed" ]]; then
    printf 'An existing service named muso is not managed by this installer; left untouched.\n' >&2
    return 1
  fi
  if ! command -v sv >/dev/null || ! command -v service-daemon >/dev/null; then
    pkg install -y termux-services
  fi
  mkdir -p "$service" "$MUSO_DATA_DIR" "$HOME/.termux/boot" "$PREFIX/etc/profile.d"
  # Keep the service down while its files are replaced.
  touch "$service/down" "$service/.muso-managed"
  if sv status "$service" >/dev/null 2>&1; then sv -w 12 down "$service"; fi
  {
    printf 'MUSO_SERVICE_REPO=%q\n' "$repo"
    printf 'MUSO_SERVICE_DATA_DIR=%q\n' "$MUSO_DATA_DIR"
    printf 'MUSO_SERVICE_PORT=%q\n' "$MUSO_PORT"
  } > "$config.tmp"
  mv "$config.tmp" "$config"
  source "$config"
  {
    printf '#!%s/bin/bash\n' "$PREFIX"
    printf 'export MUSO_DATA_DIR=%q MUSO_PORT=%q\n' "$MUSO_DATA_DIR" "$MUSO_PORT"
    printf 'cd %q || exit 1\n' "$repo"
    printf 'command -v termux-wake-lock >/dev/null && termux-wake-lock >/dev/null 2>&1 || true\n'
    printf 'exec %q -u %q >>%q 2>&1\n' "$repo/.venv/bin/python" "$repo/termux/supervise.py" "$MUSO_DATA_DIR/server.log"
  } > "$service/run.tmp"
  chmod 700 "$service/run.tmp"
  mv "$service/run.tmp" "$service/run"
  # Own only these two files; leave all existing shell and boot hooks intact.
  for hook in "$HOME/.termux/boot/90-muso" "$PREFIX/etc/profile.d/muso-autostart.sh"; do
    if [[ -e "$hook" ]] && ! grep -q '^# Muso managed startup$' "$hook"; then
      printf 'Existing startup file left untouched: %s\n' "$hook" >&2
      continue
    fi
    {
      printf '#!%s/bin/sh\n# Muso managed startup\n' "$PREFIX"
      printf '(%q %q auto >/dev/null 2>&1 </dev/null &)\n' "$PREFIX/bin/bash" "$repo/termux/service.sh"
    } > "$hook.tmp"
    chmod 700 "$hook.tmp"
    mv "$hook.tmp" "$hook"
  done
  # Stop only this checkout's historical nohup launches, then let runit own it.
  "$repo/.venv/bin/python" "$repo/termux/supervise.py" stop
  start_service
  "$PREFIX/bin/bash" "$repo/termux/muso" start
  printf 'Automatic recovery enabled. Opening Termux now starts Muso without a command.\n'
  printf 'For phone reboot startup, install Termux:Boot from the same source as Termux and open it once.\n'
  printf 'Allow Termux unrestricted battery use. Muso acquires a wake lock for screen-off playback.\n'
}
case "${1:-install}" in
  install) install_service ;;
  start) start_service ;;
  auto) managed; [[ -f "$service/down" ]] || start_service ;;
  stop) stop_service ;;
  restart) stop_service; start_service ;;
  status) managed; sv status "$service" ;;
  *) printf 'Usage: service.sh [install|start|auto|stop|restart|status]\n' >&2; exit 2 ;;
esac
