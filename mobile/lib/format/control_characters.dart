String visibleControlCharacters(String value) {
  final buffer = StringBuffer();
  for (final rune in value.runes) {
    if (rune <= 0x1f) {
      buffer.writeCharCode(0x2400 + rune);
    } else if (rune == 0x7f) {
      buffer.write('␡');
    } else if (_mustReveal(rune)) {
      buffer.write(
        '⟦U+${rune.toRadixString(16).toUpperCase().padLeft(4, '0')}⟧',
      );
    } else {
      buffer.writeCharCode(rune);
    }
  }
  return buffer.toString();
}

bool _mustReveal(int rune) =>
    (rune >= 0x80 && rune <= 0x9f) ||
    rune == 0x061c ||
    rune == 0x00ad ||
    rune == 0x034f ||
    rune == 0x115f ||
    rune == 0x1160 ||
    rune == 0x17b4 ||
    rune == 0x17b5 ||
    (rune >= 0x180b && rune <= 0x180f) ||
    (rune >= 0x200b && rune <= 0x200f) ||
    (rune >= 0x202a && rune <= 0x202e) ||
    (rune >= 0x2060 && rune <= 0x206f) ||
    rune == 0x3164 ||
    (rune >= 0xfe00 && rune <= 0xfe0f) ||
    rune == 0xfeff ||
    rune == 0xffa0 ||
    (rune >= 0xe0100 && rune <= 0xe01ef);
