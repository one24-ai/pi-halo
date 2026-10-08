#!/usr/bin/env bash
# Screenshot pi with halo: run pi in a detached tmux pane with PI_TUI_WRITE_LOG, optionally
# send a prompt, then replay the terminal output into a PNG (scripts/term2png.py, pyte + Pillow).
#
#   scripts/screenshot.sh OUT.png [COLS] [ROWS] ["prompt"] [WAIT_SECONDS]
#
# Runs in a scratch git repo under ~/.pi/agent/tmp/shot/work with your normal pi config.
# SHOT_TODO=path copies that file into the scratch repo as TODO.md; SHOT_NODRAFT=1 leaves the prompt empty.
# SHOT_FONT and SHOT_FONT_BOLD are monospace .ttf files; they default to DejaVu Sans Mono. A brand
# that uses private-use glyphs should point them at the font that has those glyphs.
set -euo pipefail
out=$(realpath -m "$1"); cols=${2:-160}; rows=${3:-42}; prompt=${4:-}; wait=${5:-30}
here=$(cd "$(dirname "$0")" && pwd)
S=~/.pi/agent/tmp/shot; W=$S/work; log=$S/last.log
rm -rf "$W"; mkdir -p "$W"; cd "$W"; git init -q
printf 'export const color = "red";\n' > button.ts; printf '# demo\n' > README.md
if [ -n "${SHOT_TODO:-}" ]; then cp "$SHOT_TODO" TODO.md; fi
rm -f "$log"; tmux kill-session -t halo-shot 2>/dev/null || true
tmux new-session -d -s halo-shot -x "$cols" -y "$rows" "COLORTERM=truecolor PI_TUI_WRITE_LOG=$log pi; sleep 120"
sleep 14
if [ -n "$prompt" ]; then tmux send-keys -t halo-shot "$prompt" Enter; sleep "$wait"; fi
if [ -z "${SHOT_NODRAFT:-}" ]; then tmux send-keys -t halo-shot "draft text"; fi; sleep 1.5
font=${SHOT_FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf}
font_bold=${SHOT_FONT_BOLD:-/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf}
uv run -q --no-project --with pyte==0.8.2 --with pillow==10.4.0 python "$here/term2png.py" "$log" "$out" "$cols" "$rows" \
  "$font" "$font_bold"
tmux kill-session -t halo-shot
