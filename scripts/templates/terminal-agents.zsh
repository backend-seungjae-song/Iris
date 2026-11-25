# 인수 없는 대화형 실행만 Iris 터미널에 연결
_iris_terminal_agent() {
  local provider=$1
  shift
  if [[ $# == 0 && -t 0 && -t 1 && -z ${HERDR_PANE_ID:-} ]] &&
     (( $+commands[herdr] && $+commands[node] )); then
    local workspace pane reply
    if reply=$(command herdr pane list 2>/dev/null) &&
       workspace=$(print -r -- "$reply" | command node -e '
         const {panes} = JSON.parse(require("fs").readFileSync(0)).result;
         const ids = [...new Set(panes.filter(p => p.cwd === process.cwd()).map(p => p.workspace_id))];
         if (ids.length === 1) process.stdout.write(ids[0]);
       '); then
      if [[ -n $workspace ]]; then
        reply=$(command herdr tab create --workspace "$workspace" --cwd "$PWD" --label "$provider" --no-focus) || return 1
      else
        reply=$(command herdr workspace create --cwd "$PWD" --label "${PWD:t}" --no-focus) || return 1
      fi
      pane=$(print -r -- "$reply" | command node -e '
        const id = JSON.parse(require("fs").readFileSync(0)).result.root_pane.pane_id;
        if (!id) process.exit(1);
        process.stdout.write(id);
      ') || return 1
      command herdr pane run "$pane" "$provider" >/dev/null || return 1
      local attempt
      for attempt in {1..100}; do
        if command herdr agent get "$pane" >/dev/null 2>&1; then
          command herdr agent attach "$pane"
          return $?
        fi
        sleep 0.1
      done
      print -u2 "Iris에서 $provider 시작을 확인하지 못했습니다 ($pane)."
      return 1
    fi
  fi
  if (( $+functions[_iris_original_$provider] )); then
    "_iris_original_$provider" "$@"
  else
    command "$provider" "$@"
  fi
}

for _iris_provider in codex claude agy; do
  if [[ ${functions[$_iris_provider]-} != *'_iris_terminal_agent '* ]]; then
    if (( $+functions[$_iris_provider] )); then
      functions -c "$_iris_provider" "_iris_original_$_iris_provider"
    fi
    functions[$_iris_provider]="_iris_terminal_agent $_iris_provider \"\$@\""
  fi
done
unset _iris_provider
