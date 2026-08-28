#!/bin/bash
# switch-session.sh — move a live pi session to another project, keeping its id,
# its memory and its peer crew.
#
#   switch-session.sh <target-dir> <tmux-target> <session-file> [wake-message] [--socket NAME]
#
# PRECONDITION: the tmux pane's process must be a SHELL running pi (e.g.
# `tmux new-session ... bash` then `send-keys pi Enter`), not `pi` launched as
# the pane's direct command. If pi IS the pane's own process, the pane is
# destroyed the instant pi exits (Ctrl+D) and there is nothing left to type
# the resume command into. The helper detects this and reports it rather
# than silently doing nothing (incident 2026-08-05).
#
# What it does, in order:
#   1. PRE-TRUSTS the target directory. pi asks "do you trust this folder?" on
#      first use; that dialog swallows scripted keystrokes and the switch silently
#      fails (it did, on 2026-08-05 — this step is why the script exists).
#   2. Exits the running session cleanly, so the crew SUSPENDS (recoverable) and
#      the transcript is flushed to disk.
#   3. Copies the session file into the target project's session directory,
#      rewriting only the cwd field of its header line.
#   4. Resumes it there and (optionally) types a wake message.
#
# Exit codes: 0 ok · 1 usage/precondition · 2 the session never came back up.
set -euo pipefail

TARGET="${1:-}"; PANE="${2:-}"; SRC="${3:-}"; WAKE="${4:-}"
SOCKET=""
if [ "${5:-}" = "--socket" ] && [ -n "${6:-}" ]; then SOCKET="-L $6"; fi
if [ -z "$TARGET" ] || [ -z "$PANE" ] || [ -z "$SRC" ]; then
  echo "usage: switch-session.sh <target-dir> <tmux-target> <session-file> [wake-message] [--socket NAME]" >&2
  exit 1
fi
[ -d "$TARGET" ] || { echo "switch-session: target directory does not exist: $TARGET" >&2; exit 1; }
[ -f "$SRC" ] || { echo "switch-session: session file does not exist: $SRC" >&2; exit 1; }
TARGET="$(cd "$TARGET" && pwd)"
TMUX="tmux $SOCKET"

# 1. pre-trust ---------------------------------------------------------------
python3 - "$TARGET" <<'PY'
import json, os, sys
p = os.path.expanduser("~/.pi/agent/trust.json")
d = {}
if os.path.exists(p):
    try:
        d = json.load(open(p))
    except Exception:
        d = {}
d[sys.argv[1]] = True
os.makedirs(os.path.dirname(p), exist_ok=True)
json.dump(d, open(p, "w"), indent=1)
print(f"pre-trusted {sys.argv[1]}")
PY

# 2. clean exit (crew suspends, transcript flushes) ---------------------------
$TMUX send-keys -t "$PANE" Escape; sleep 1
$TMUX send-keys -t "$PANE" C-c; sleep 1
$TMUX send-keys -t "$PANE" C-d
for _ in $(seq 1 20); do
  cmd=$($TMUX display-message -p -t "$PANE" '#{pane_current_command}' 2>/dev/null || echo gone)
  [ "$cmd" = "pi" ] || break
  sleep 1
done
if ! $TMUX display-message -p -t "$PANE" '#{pane_id}' >/dev/null 2>&1; then
  echo "switch-session: pane '$PANE' did not survive pi exiting — it was launched with pi as the pane's OWN process, not a shell. Relaunch the pane with a shell (see PRECONDITION above) and retry." >&2
  exit 1
fi

# 3. fork into the target project's session dir ------------------------------
# Read the OLD cwd before we overwrite it -- the peer crew's state
# (.pi/peer-agent/) lives keyed by project directory, not inside the session
# file, so a session fork alone does not bring it along.
OLD_CWD=$(python3 -c "import json,sys; print(json.loads(open(sys.argv[1]).readline())['cwd'])" "$SRC")
DSTDIR="$HOME/.pi/agent/sessions/$(python3 -c "import sys; print('--' + sys.argv[1].strip('/').replace('/', '-') + '--')" "$TARGET")"
mkdir -p "$DSTDIR"
DST="$DSTDIR/$(basename "$SRC")"
python3 - "$SRC" "$DST" "$TARGET" <<'PY'
import json, sys
src, dst, cwd = sys.argv[1:4]
with open(src) as f, open(dst, "w") as out:
    header = json.loads(f.readline())
    header["cwd"] = cwd
    out.write(json.dumps(header) + "\n")
    for line in f:
        out.write(line)
print(f"forked -> {dst}")
PY

# 3b. migrate the peer crew's state (session id is UNCHANGED, so roster
# entries' parentSessionId still match once recovery runs in the new cwd).
if [ -f "$OLD_CWD/.pi/peer-agent/roster.json" ]; then
  mkdir -p "$TARGET/.pi/peer-agent"
  cp -n "$OLD_CWD/.pi/peer-agent/roster.json" "$TARGET/.pi/peer-agent/roster.json" 2>/dev/null || true
  [ -f "$OLD_CWD/.pi/peer-agent/events.jsonl" ] && cat "$OLD_CWD/.pi/peer-agent/events.jsonl" >> "$TARGET/.pi/peer-agent/events.jsonl"
  echo "migrated crew state: $OLD_CWD/.pi/peer-agent -> $TARGET/.pi/peer-agent"
fi

# 4. resume there, then wake --------------------------------------------------
$TMUX send-keys -t "$PANE" "cd '$TARGET' && pi --session '$DST'" Enter
up=1
for _ in $(seq 1 40); do
  if $TMUX capture-pane -p -t "$PANE" 2>/dev/null | grep -q "⬢"; then up=0; break; fi
  sleep 1
done
[ "$up" -eq 0 ] || { echo "switch-session: session did not come back up" >&2; exit 2; }
if [ -n "$WAKE" ]; then
  sleep 3
  $TMUX send-keys -t "$PANE" "$WAKE" Enter
fi
echo "switched: $TARGET ($DST)"
