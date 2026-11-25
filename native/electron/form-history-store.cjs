// 입력 기록의 프로필·입력창별 보존 규칙

const MAX_VALUE_LENGTH = 200;
const MAX_VALUES = 50;
const MAX_ADD_ENTRIES = 50;
const MAX_KEY_LENGTH = 100;
const MAX_PROFILE_KEYS = 500;
const MAX_RESULTS = 8;
const MAX_AGE = 365 * 86_400_000;

function normalizeKey(rawKey) {
  if (typeof rawKey !== "string" || rawKey.length > MAX_KEY_LENGTH) return "";
  const key = rawKey.trim().toLowerCase();
  return key.length <= MAX_KEY_LENGTH ? key : "";
}

const validValue = (value) => typeof value === "string" && value.length <= MAX_VALUE_LENGTH && value.trim() !== "";
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;

function freshEntries(entries, time) {
  return Array.isArray(entries) ? entries.filter((item) =>
    item && validValue(item.v) && Number.isSafeInteger(item.n) && item.n > 0
    && Number.isFinite(item.t) && time - item.t <= MAX_AGE) : [];
}

function lastUsed(entries) {
  if (!Array.isArray(entries)) return -Infinity;
  return entries.reduce((latest, item) => Number.isFinite(item?.t) ? Math.max(latest, item.t) : latest, -Infinity);
}

function createFormHistoryStore({ load, persist }, now = Date.now) {
  function persistEntries(data, partition, key, entries) {
    const profile = { ...data[partition], [key]: entries };
    if (!entries.length) delete profile[key];
    return persist({ ...data, [partition]: profile });
  }

  function query(partition, rawKey, prefix) {
    const key = normalizeKey(rawKey);
    if (!key || typeof prefix !== "string" || prefix.length > MAX_VALUE_LENGTH) return [];
    const data = load(partition);
    const profile = own(data || {}, partition);
    if (!record(profile)) return [];
    const saved = own(profile, key);
    const entries = freshEntries(saved, now());
    if (Array.isArray(saved) && entries.length !== saved.length) persistEntries(data, partition, key, entries);
    const start = prefix.toLowerCase();
    return entries
      .filter(({ v }) => v.toLowerCase().startsWith(start))
      .sort((a, b) => b.n - a.n || b.t - a.t)
      .slice(0, MAX_RESULTS)
      .map(({ v }) => v);
  }

  function add(partition, entries) {
    if (!Array.isArray(entries)) return false;
    const data = load(partition);
    if (data === null) return false;
    const profile = Object.assign(Object.create(null), own(data, partition));
    const time = now();
    const updates = new Map();
    for (const entry of entries.slice(0, MAX_ADD_ENTRIES)) {
      const key = normalizeKey(entry?.key);
      const value = entry?.value;
      if (!key || !validValue(value)) continue;
      if (!updates.has(key)) updates.set(key, new Map(freshEntries(own(profile, key), time).map((item) => [item.v, item])));
      const items = updates.get(key);
      const count = items.get(value)?.n || 0;
      items.set(value, { v: value, n: count + 1, t: time });
    }
    if (!updates.size) return false;
    for (const [key, items] of updates) {
      profile[key] = [...items.values()].reverse().sort((a, b) => b.t - a.t).slice(0, MAX_VALUES);
    }
    const keys = Object.keys(profile);
    if (keys.length > MAX_PROFILE_KEYS) {
      const ranked = keys.map((key) => ({ key, time: lastUsed(profile[key]), updated: Number(updates.has(key)) }));
      ranked.sort((a, b) => b.time - a.time || b.updated - a.updated);
      for (const { key } of ranked.slice(MAX_PROFILE_KEYS)) delete profile[key];
    }
    return persist({ ...data, [partition]: profile });
  }

  function remove(partition, rawKey, value) {
    const key = normalizeKey(rawKey);
    if (!key || !validValue(value)) return false;
    const data = load(partition);
    if (!data) return false;
    const profile = own(data, partition);
    if (!record(profile) || !Object.hasOwn(profile, key)) return true;
    const kept = freshEntries(profile[key], now()).filter(({ v }) => v !== value);
    return persistEntries(data, partition, key, kept);
  }

  return { query, add, remove };
}

module.exports = { createFormHistoryStore };
