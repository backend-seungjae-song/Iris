export function resetTokenBucket(state, now, capacity) {
  state.tokens = capacity;
  state.updatedAt = now;
}

export function takeToken(state, now, { perSecond, capacity }) {
  if (!Number.isFinite(state.tokens) || !Number.isFinite(state.updatedAt)) {
    resetTokenBucket(state, now, capacity);
  }

  const elapsedMs = Math.max(0, now - state.updatedAt);
  state.tokens = Math.min(
    capacity,
    state.tokens + (elapsedMs * perSecond) / 1000,
  );
  state.updatedAt = Math.max(state.updatedAt, now);

  if (state.tokens < 1) return false;
  state.tokens -= 1;
  return true;
}
