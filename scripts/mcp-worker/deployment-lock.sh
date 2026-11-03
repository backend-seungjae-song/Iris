iris_deployment_lock_acquire() {
  if [ "$#" -ne 1 ] || [ -z "$1" ]; then
    echo "상태 폴더가 필요합니다." >&2
    return 64
  fi
  IRIS_DEPLOYMENT_LOCK_DIR="$1/deployment.lock"
  IRIS_DEPLOYMENT_LOCK_TOKEN="$(uuidgen 2>/dev/null || printf '%s-%s' "$$" "$(date +%s)")"
  export IRIS_DEPLOYMENT_LOCK_DIR IRIS_DEPLOYMENT_LOCK_TOKEN
  if ! mkdir "$IRIS_DEPLOYMENT_LOCK_DIR" 2>/dev/null; then
    iris_lock_pid="$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$IRIS_DEPLOYMENT_LOCK_DIR/owner.json" 2>/dev/null || true)"
    if [ -n "$iris_lock_pid" ] && ! /bin/ps -p "$iris_lock_pid" -o pid= >/dev/null 2>&1; then
      iris_stale_lock="$1/.deployment.lock.stale-$$-$IRIS_DEPLOYMENT_LOCK_TOKEN"
      if mv "$IRIS_DEPLOYMENT_LOCK_DIR" "$iris_stale_lock" 2>/dev/null; then
        rm "$iris_stale_lock/owner.json" 2>/dev/null || true
        rmdir "$iris_stale_lock" 2>/dev/null || true
      fi
    fi
    if ! mkdir "$IRIS_DEPLOYMENT_LOCK_DIR" 2>/dev/null; then
      echo "다른 배포가 진행 중입니다: $IRIS_DEPLOYMENT_LOCK_DIR" >&2
      return 73
    fi
  fi
  iris_previous_umask="$(umask)"
  umask 077
  printf '{"schemaVersion":1,"token":"%s","owner":"full-install","pid":%s}\n' \
    "$IRIS_DEPLOYMENT_LOCK_TOKEN" "$$" > "$IRIS_DEPLOYMENT_LOCK_DIR/owner.json"
  umask "$iris_previous_umask"
  unset iris_previous_umask iris_lock_pid iris_stale_lock
}

iris_deployment_lock_release() {
  if [ -z "${IRIS_DEPLOYMENT_LOCK_DIR:-}" ] || [ -z "${IRIS_DEPLOYMENT_LOCK_TOKEN:-}" ]; then
    return 0
  fi
  if [ ! -f "$IRIS_DEPLOYMENT_LOCK_DIR/owner.json" ]; then
    return 1
  fi
  if ! grep -Fq "\"token\":\"$IRIS_DEPLOYMENT_LOCK_TOKEN\"" "$IRIS_DEPLOYMENT_LOCK_DIR/owner.json"; then
    echo "배포 잠금 소유권이 바뀌어 해제하지 않았습니다." >&2
    return 1
  fi
  rm "$IRIS_DEPLOYMENT_LOCK_DIR/owner.json"
  rmdir "$IRIS_DEPLOYMENT_LOCK_DIR"
  unset IRIS_DEPLOYMENT_LOCK_DIR IRIS_DEPLOYMENT_LOCK_TOKEN
}
