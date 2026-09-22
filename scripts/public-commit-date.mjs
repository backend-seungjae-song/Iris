export function publicCommitDate(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("유효한 날짜가 필요합니다");
  }
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const local = kst.toISOString().slice(0, 19);
  const hour = kst.getUTCHours();
  return `${hour >= 9 && hour < 19 ? `${local.slice(0, 10)}T00:00:00` : local}+09:00`;
}
