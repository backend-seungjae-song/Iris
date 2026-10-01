import { isIP } from "node:net";

export function isAllowedListenAddress(address) {
  if (isIP(address) !== 4) return false;
  if (address === "0.0.0.0") return false;
  const first = Number(address.split(".", 1)[0]);
  return first !== 127;
}
