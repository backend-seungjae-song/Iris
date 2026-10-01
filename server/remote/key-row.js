import fs from "node:fs";
import path from "node:path";

import { keymapWire } from "../keymap-store.js";
import { resolvedKeymap, setOverrides } from "../../web/js/core/keymap.js";
import { stateHome } from "../state-home.cjs";

const FILE = "phone-key-row.json";
const DEFAULTS = Object.freeze([
  { id: "esc", label: "Esc", key: "Escape", modifiers: { ctrl: false, alt: false, shift: false, cmd: false } },
  { id: "tab", label: "Tab", key: "Tab", modifiers: { ctrl: false, alt: false, shift: false, cmd: false } },
  { id: "up", label: "↑", key: "ArrowUp", modifiers: { ctrl: false, alt: false, shift: false, cmd: false } },
  { id: "down", label: "↓", key: "ArrowDown", modifiers: { ctrl: false, alt: false, shift: false, cmd: false } },
  { id: "left", label: "←", key: "ArrowLeft", modifiers: { ctrl: false, alt: false, shift: false, cmd: false } },
  { id: "right", label: "→", key: "ArrowRight", modifiers: { ctrl: false, alt: false, shift: false, cmd: false } },
  { id: "ctrl-c", label: "⌃C", key: "c", modifiers: { ctrl: true, alt: false, shift: false, cmd: false } },
  { id: "enter", label: "Enter", key: "Enter", modifiers: { ctrl: false, alt: false, shift: false, cmd: false } },
]);

function copy(value) { return structuredClone(value); }

export function createKeyRowStore(options = {}) {
  const root = options.stateDir || stateHome();
  const file = path.join(root, "remote", FILE);
  let keys = null;

  function load() {
    if (keys) return keys;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      keys = Array.isArray(parsed?.keys) ? parsed.keys.slice(0, 24) : copy(DEFAULTS);
    } catch { keys = copy(DEFAULTS); }
    return keys;
  }

  function macShortcuts() {
    try {
      setOverrides(keymapWire().overrides);
      return resolvedKeymap().filter((item) => item.binding && !item.lock).slice(0, 40).map((item) => ({
        id: item.id,
        label: item.label,
        keys: [item.binding.mod ? "⌘" : "", item.binding.alt ? "⌥" : "", item.binding.shift ? "⇧" : "",
          item.binding.key || String(item.binding.code || "").replace(/^Key|^Digit/, "")].join(""),
      }));
    } catch { return []; }
  }

  return {
    get() { return { keys: copy(load()), defaults: copy(DEFAULTS), macShortcuts: macShortcuts() }; },
    set(next) {
      keys = copy(next);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ keys }), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, file);
      return this.get();
    },
  };
}
