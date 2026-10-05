// 번역 언어·자동 번역·제외 설정은 브라우저 프로필마다 저장한다.
export const TRANSLATE_SETTINGS_PREFIX = "iris.pageTranslate.settings.v1:";
export const LANGUAGE_CODES = "af sq am ar hy as ay az bm eu be bn bho bs bg ca ceb ny zh-CN zh-TW co hr cs da dv doi nl en eo et ee fil fi fr fy gl ka de el gn gu ht ha haw he hi hmn hu is ig ilo id ga it ja jv kn kk km rw gom ko kri ku ckb ky lo la lv ln lt lg lb mk mai mg ms ml mt mi mr mni-Mtei lus mn my ne no or om ps fa pl pt pa qu ro ru sm sa gd nso sr st sn sd si sk sl so es su sw sv tl tg ta tt te th ti ts tr tk ak uk ur ug uz vi cy xh yi yo zu".split(" ");
const supported = new Set(LANGUAGE_CODES);
const canonical = new Map(LANGUAGE_CODES.map((code) => [code.toLowerCase(), code]));

export function languageCode(value) {
  const code = String(value || "").trim().replaceAll("_", "-").toLowerCase();
  if (/^zh-(tw|hk|mo|hant)/.test(code)) return "zh-TW";
  if (code === "zh" || code.startsWith("zh-")) return "zh-CN";
  const base = code.split("-")[0];
  return canonical.get(code) || canonical.get(base) || "auto";
}

export function languageOptions() {
  const names = new Intl.DisplayNames(["ko"], { type: "language" });
  return LANGUAGE_CODES.map((value) => {
    let label = value;
    try { label = names.of(value) || value; } catch {}
    return { value, label };
  }).sort((a, b) => a.label.localeCompare(b.label, "ko"));
}

export function translationSettings(storage, partition) {
  let raw;
  try { raw = JSON.parse(storage?.getItem(TRANSLATE_SETTINGS_PREFIX + partition) || "null"); } catch {}
  const languages = (values) => Array.isArray(values) ? [...new Set(values.filter((value) => supported.has(value)))] : [];
  return {
    target: supported.has(raw?.target) ? raw.target : "ko",
    always: languages(raw?.always),
    never: languages(raw?.never),
    neverSites: Array.isArray(raw?.neverSites) ? raw.neverSites.filter((value) => {
      try { const url = new URL(value); return /^https?:$/.test(url.protocol) && url.origin === value; } catch { return false; }
    }) : [],
  };
}

export function saveTranslationSettings(storage, partition, settings) {
  storage.setItem(TRANSLATE_SETTINGS_PREFIX + partition, JSON.stringify(settings));
}

// lang가 기본 템플릿 값인 사이트는 본문의 문자 분포로 한국어·일본어·중국어를 먼저 확인한다.
export function detectPageLanguage({ language, text = "" } = {}) {
  const sample = String(text).slice(0, 12000);
  const letters = (sample.match(/\p{L}/gu) || []).length;
  if (letters < 12) return { language: languageCode(language), hasText: false };
  const count = (pattern) => (sample.match(pattern) || []).length;
  if (count(/[가-힣]/g) / letters > 0.25) return { language: "ko", hasText: true };
  if (count(/[ぁ-ゟ゠-ヿ]/g) / letters > 0.08) return { language: "ja", hasText: true };
  const declared = languageCode(language);
  if (count(/[\u3400-\u9fff]/g) / letters > 0.3) return { language: declared === "zh-TW" ? declared : "zh-CN", hasText: true };
  return { language: declared, hasText: true };
}
