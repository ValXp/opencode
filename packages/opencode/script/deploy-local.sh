#!/usr/bin/env bash
set -euo pipefail
umask 077

target=/root/opencode/packages/opencode/dist/opencode-linux-x64/bin/opencode
backups=/root/opencode-rollback
service=opencode.service
url=http://127.0.0.1:80

if [[ ${1:-} != --run ]]; then
  [[ $# == 0 ]] || { printf 'Usage: bash %s\n' "$0" >&2; exit 2; }
  unit="opencode-deploy-$(date +%s)-$$"
  systemd-run --unit="$unit" --on-active=15s --timer-property=AccuracySec=1s \
    /bin/bash "$(readlink -f "$0")" --run
  printf 'Scheduled only: %s.timer; inspect system journal and %s after reconnecting.\n' "$unit" "$backups"
  exit 0
fi
[[ $# == 1 ]]

for cmd in jq flock curl timeout sha256sum systemctl install; do
  command -v "$cmd" >/dev/null
done
mkdir -p "$backups"
exec 9>"$backups/deploy.lock"
flock -n 9
run=$(mktemp -d "$backups/$(date +%Y%m%d-%H%M%S)-XXXXXX")
exec >"$run/deploy.log" 2>&1
printf 'Deployment artifacts: %s\n' "$run"
switched=0
stage=

hash() {
  sha256sum "$1" | cut -d ' ' -f 1
}

install_binary() {
  stage=$(mktemp "${target}.deploy-XXXXXX")
  install -m 755 "$1" "$stage" || return
  mv -fT "$stage" "$target" || return
  switched=1
  stage=
}

verify() {
  local expected=$1 previous=$2 pid executable
  for ((attempt=0; attempt<30; attempt++)); do
    pid=$(systemctl show "$service" --property=MainPID --value) || return
    if [[ $pid =~ ^[1-9][0-9]*$ && $pid != "$previous" ]] && systemctl is-active --quiet "$service"; then
      executable=$(readlink "/proc/$pid/exe") || return
      [[ $executable == "$target" ]] || return 1
      [[ $(hash "/proc/$pid/exe") == "$expected" ]] || return 1
      if curl --fail --silent --show-error --max-time 2 "$url/global/health" | jq -e '.healthy == true' >/dev/null; then
        systemctl show "$service" --property=MainPID,ExecMainStartTimestamp
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

finish() {
  local status=$?
  trap - EXIT HUP INT TERM
  # A signal can arrive after rename succeeds but before switched is assigned.
  if (( status != 0 )) && { (( switched )) || [[ -n $stage && ! -e $stage ]]; }; then
    printf 'Deployment failed (%s); restoring running executable snapshot.\n' "$status"
    if install_binary "$run/previous" && timeout --kill-after=10s 60s systemctl restart "$service" && verify "$old_hash" 0; then
      printf 'Rollback verified (binary and health).\n'
    else
      printf 'ROLLBACK FAILED: manual recovery required; snapshot: %s/previous\n' "$run" >&2
    fi
  fi
  if [[ -n $stage ]]; then rm -f "$stage"; fi
  exit "$status"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

systemctl show "$service" --property=LoadState,ActiveState,SubState,MainPID,ExecMainStartTimestamp,FragmentPath >"$run/before.txt"
systemctl is-active --quiet "$service"
old_pid=$(systemctl show "$service" --property=MainPID --value)
[[ $old_pid =~ ^[1-9][0-9]*$ ]]
old_start=$(systemctl show "$service" --property=ExecMainStartTimestamp --value)
executable=$(readlink "/proc/$old_pid/exe")
[[ ${executable% (deleted)} == "$target" ]]
[[ -f $target && -x $target && ! -L $target ]]
# The on-disk build may already differ from the running (deleted) inode.
cp --dereference "/proc/$old_pid/exe" "$run/previous"
cp --dereference "$target" "$run/candidate"
old_hash=$(hash "$run/previous")
candidate_hash=$(hash "$run/candidate")
printf 'Old PID=%s start=%s hash=%s\nCandidate hash=%s\n' "$old_pid" "$old_start" "$old_hash" "$candidate_hash"
[[ $(systemctl show "$service" --property=MainPID --value) == "$old_pid" ]]
[[ $(systemctl show "$service" --property=ExecMainStartTimestamp --value) == "$old_start" ]]
[[ $(hash "/proc/$old_pid/exe") == "$old_hash" ]]

install_binary "$run/candidate"
timeout --kill-after=10s 60s systemctl restart "$service"
verify "$candidate_hash" "$old_pid"
timeout --kill-after=10s 180s "$target" run --attach "$url" --dir /root --format json --title deploy-smoke \
  'Do not use tools. Reply with exactly DEPLOY_SMOKE_OK and nothing else.' \
  </dev/null >"$run/smoke.jsonl" 2>"$run/smoke.stderr"
jq -se '
  length > 0 and
  all(.[]; .type != "error" and .type != "tool_use") and
  ([.[].sessionID] | unique | length == 1) and
  all(.[]; (.sessionID | type) == "string" and (.sessionID | length) > 0) and
  ([.[] | select(.type == "text") | .part.text] | join("") == "DEPLOY_SMOKE_OK") and
  ([.[] | select(.type == "step_finish")] | length > 0 and all(.[]; .part.reason == "stop"))
' "$run/smoke.jsonl" >/dev/null
verify "$candidate_hash" "$old_pid"
printf 'Deployment verified: fresh default-model session completed.\n'
