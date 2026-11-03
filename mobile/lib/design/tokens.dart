import 'package:flutter/material.dart';

// 시안 common.css 토큰. 기존 필드명은 유지하고 값만 시안 팔레트로 교체
@immutable
class IrisColors extends ThemeExtension<IrisColors> {
  const IrisColors({
    required this.background,
    required this.level1,
    required this.level2,
    required this.level3,
    required this.separator,
    required this.foreground,
    required this.foreground2,
    required this.muted,
    required this.faint,
    required this.brand,
    required this.onBrand,
    required this.link,
    required this.working,
    required this.done,
    required this.idle,
    required this.blocked,
    required this.question,
    required this.terminal,
    required this.background2,
    required this.tint,
    required this.tint2,
    required this.tint3,
    required this.line2,
    required this.accentEdge,
    required this.strong,
    required this.dangerText,
    required this.dangerTint,
    required this.okText,
    required this.okTint,
    required this.addBg,
    required this.addMark,
    required this.delBg,
    required this.delMark,
    required this.scrim,
    required this.shadow,
    required this.shadowRing,
    required this.sky,
    required this.teal,
    required this.mint,
    required this.lime,
    required this.yellow,
    required this.pink,
    required this.ink,
    required this.keyboard,
    required this.key,
    required this.key2,
    required this.keyText,
    required this.terminalFg,
    required this.termDim,
    required this.termGreen,
    required this.termCyan,
    required this.termYellow,
    required this.termRed,
    required this.termBlue,
    required this.termTeal,
    required this.termLime,
    required this.termSelection,
    required this.mark,
    required this.markText,
  });

  // 기존 이름: background=--bg, level1~3=--surface~3, separator=--line,
  // foreground=--text, foreground2=--text-2, muted=--text-3, faint=--dim,
  // brand=--accent, onBrand=--on-accent
  final Color background;
  final Color level1;
  final Color level2;
  final Color level3;
  final Color separator;
  final Color foreground;
  final Color foreground2;
  final Color muted;
  final Color faint;
  final Color brand;
  final Color onBrand;
  final Color link;
  // 상태 글자색. 칩 배경이 아니라 글자·점·아이콘용
  final Color working;
  final Color done;
  final Color idle;
  final Color blocked;
  final Color question;
  // 터미널 배경 --term-bg
  final Color terminal;

  // 새 토큰
  final Color background2;
  final Color tint;
  final Color tint2;
  final Color tint3;
  final Color line2;
  final Color accentEdge;
  final Color strong;
  final Color dangerText;
  final Color dangerTint;
  final Color okText;
  final Color okTint;
  final Color addBg;
  final Color addMark;
  final Color delBg;
  final Color delMark;
  final Color scrim;
  final Color shadow;
  final Color shadowRing;
  // 상태칩 팝 색. 라이트·다크 같은 값
  final Color sky;
  final Color teal;
  final Color mint;
  final Color lime;
  final Color yellow;
  final Color pink;
  // 팝 색 위 글자 --ink-on-pop
  final Color ink;
  final Color keyboard;
  final Color key;
  final Color key2;
  final Color keyText;
  final Color terminalFg;
  final Color termDim;
  final Color termGreen;
  final Color termCyan;
  final Color termYellow;
  final Color termRed;
  final Color termBlue;
  final Color termTeal;
  final Color termLime;
  final Color termSelection;
  final Color mark;
  final Color markText;

  static const dark = IrisColors(
    background: Color(0xff0A1219),
    level1: Color(0xff13202B),
    level2: Color(0xff1A2834),
    level3: Color(0xff233444),
    separator: Color.fromRGBO(191, 218, 247, .10),
    foreground: Color(0xffEAF5FB),
    foreground2: Color(0xffC3D6E3),
    muted: Color(0xff8CA6B8),
    faint: Color(0xff5E7B8E),
    brand: Color(0xffA6DAF4),
    onBrand: Color(0xff06202E),
    link: Color(0xffA6DAF4),
    working: Color(0xff85E8F6),
    done: Color(0xff8BFBC2),
    idle: Color(0xff5E7B8E),
    blocked: Color(0xffF4A1A7),
    question: Color(0xffF9F871),
    terminal: Color(0xff060E14),
    background2: Color(0xff0E1821),
    tint: Color.fromRGBO(166, 218, 244, .07),
    tint2: Color.fromRGBO(166, 218, 244, .14),
    tint3: Color.fromRGBO(166, 218, 244, .22),
    line2: Color.fromRGBO(191, 218, 247, .19),
    accentEdge: Color(0x00000000),
    strong: Color(0xff00AFF0),
    dangerText: Color(0xffF4A1A7),
    dangerTint: Color.fromRGBO(244, 161, 167, .13),
    okText: Color(0xff8BFBC2),
    okTint: Color.fromRGBO(126, 198, 153, .14),
    addBg: Color.fromRGBO(126, 198, 153, .15),
    addMark: Color(0xff8BFBC2),
    delBg: Color.fromRGBO(244, 161, 167, .14),
    delMark: Color(0xffF4A1A7),
    scrim: Color.fromRGBO(2, 7, 11, .62),
    shadow: Color.fromRGBO(0, 0, 0, .5),
    shadowRing: Color.fromRGBO(191, 218, 247, .08),
    sky: Color(0xff85E8F6),
    teal: Color(0xff74F3E5),
    mint: Color(0xff8BFBC2),
    lime: Color(0xffBCFD97),
    yellow: Color(0xffF9F871),
    pink: Color(0xffF4A1A7),
    ink: Color(0xff06202E),
    keyboard: Color(0xff121D26),
    key: Color(0xff2A3A48),
    key2: Color(0xff1C2A35),
    keyText: Color(0xffEAF5FB),
    terminalFg: Color(0xffC3D6E3),
    termDim: Color(0xff7F9AAD),
    termGreen: Color(0xff8BFBC2),
    termCyan: Color(0xff85E8F6),
    termYellow: Color(0xffF9F871),
    termRed: Color(0xffF4A1A7),
    termBlue: Color(0xffA6DAF4),
    termTeal: Color(0xff74F3E5),
    termLime: Color(0xffBCFD97),
    termSelection: Color.fromRGBO(0, 175, 240, .28),
    mark: Color(0xffF9F871),
    markText: Color(0xff06202E),
  );

  static const light = IrisColors(
    background: Color(0xffF2F9FC),
    level1: Color(0xffFFFFFF),
    level2: Color(0xffEAF5FB),
    level3: Color(0xffD7ECF7),
    separator: Color.fromRGBO(11, 28, 39, .09),
    foreground: Color(0xff0B1C27),
    foreground2: Color(0xff2E4A5C),
    muted: Color(0xff4A6475),
    faint: Color(0xff91A9B8),
    brand: Color(0xffA6DAF4),
    onBrand: Color(0xff06202E),
    link: Color(0xff0A6E99),
    working: Color(0xff0B6D8F),
    done: Color(0xff1F7A4A),
    idle: Color(0xff91A9B8),
    blocked: Color(0xffA63A44),
    question: Color(0xff6F5A00),
    terminal: Color(0xffE6F4F1),
    background2: Color(0xffE9F4FA),
    tint: Color.fromRGBO(166, 218, 244, .20),
    tint2: Color.fromRGBO(166, 218, 244, .36),
    tint3: Color.fromRGBO(166, 218, 244, .55),
    line2: Color.fromRGBO(11, 28, 39, .17),
    accentEdge: Color.fromRGBO(6, 32, 46, .16),
    strong: Color(0xff00A6FB),
    dangerText: Color(0xffA63A44),
    dangerTint: Color.fromRGBO(244, 161, 167, .22),
    okText: Color(0xff1F7A4A),
    okTint: Color.fromRGBO(126, 198, 153, .22),
    addBg: Color.fromRGBO(126, 198, 153, .24),
    addMark: Color(0xff1F7A4A),
    delBg: Color.fromRGBO(244, 161, 167, .26),
    delMark: Color(0xffA63A44),
    scrim: Color.fromRGBO(11, 28, 39, .32),
    shadow: Color.fromRGBO(11, 40, 60, .16),
    shadowRing: Color.fromRGBO(11, 28, 39, .07),
    sky: Color(0xff85E8F6),
    teal: Color(0xff74F3E5),
    mint: Color(0xff8BFBC2),
    lime: Color(0xffBCFD97),
    yellow: Color(0xffF9F871),
    pink: Color(0xffF4A1A7),
    ink: Color(0xff06202E),
    keyboard: Color(0xffDCE9F1),
    key: Color(0xffFFFFFF),
    key2: Color(0xffC3D6E3),
    keyText: Color(0xff0B1C27),
    terminalFg: Color(0xff16303F),
    termDim: Color(0xff557083),
    termGreen: Color(0xff1F7A4A),
    termCyan: Color(0xff0B6D8F),
    termYellow: Color(0xff6F5A00),
    termRed: Color(0xffA23A44),
    termBlue: Color(0xff0A6E99),
    termTeal: Color(0xff0E6E66),
    termLime: Color(0xff3D6B12),
    termSelection: Color.fromRGBO(0, 166, 251, .22),
    mark: Color(0xffF9F871),
    markText: Color(0xff06202E),
  );

  @override
  IrisColors copyWith() => this;

  @override
  IrisColors lerp(covariant ThemeExtension<IrisColors>? other, double t) =>
      this;
}

// 시안 반경 --r-*
abstract final class IrisRadius {
  static const pill = 999.0;
  static const card = 14.0;
  static const field = 10.0;
  static const small = 6.0;
  static const sheet = 20.0;
}

// 시안 --ease, --ease-drawer
const irisEase = Cubic(.23, 1, .32, 1);
const irisEaseDrawer = Cubic(.32, .72, 0, 1);

extension IrisBuildContext on BuildContext {
  IrisColors get iris => Theme.of(this).extension<IrisColors>()!;
}

ThemeData irisTheme(Brightness brightness) {
  final colors = brightness == Brightness.dark
      ? IrisColors.dark
      : IrisColors.light;
  final baseTextTheme = ThemeData(brightness: brightness).textTheme;
  final textTheme = baseTextTheme.copyWith(
    displayLarge: baseTextTheme.displayLarge?.copyWith(
      height: 1.2,
      letterSpacing: 0,
    ),
    displayMedium: baseTextTheme.displayMedium?.copyWith(
      height: 1.2,
      letterSpacing: 0,
    ),
    displaySmall: baseTextTheme.displaySmall?.copyWith(
      height: 1.2,
      letterSpacing: 0,
    ),
    headlineLarge: baseTextTheme.headlineLarge?.copyWith(
      height: 1.2,
      letterSpacing: 0,
    ),
    headlineMedium: baseTextTheme.headlineMedium?.copyWith(
      height: 1.2,
      letterSpacing: 0,
    ),
    headlineSmall: baseTextTheme.headlineSmall?.copyWith(
      height: 1.2,
      letterSpacing: 0,
    ),
    titleLarge: baseTextTheme.titleLarge?.copyWith(
      height: 1.2,
      letterSpacing: 0,
    ),
    titleMedium: baseTextTheme.titleMedium?.copyWith(
      height: 1.2,
      letterSpacing: 0,
    ),
    titleSmall: baseTextTheme.titleSmall?.copyWith(
      height: 1.2,
      letterSpacing: 0,
    ),
    bodyLarge: baseTextTheme.bodyLarge?.copyWith(height: 1.2, letterSpacing: 0),
    bodyMedium: baseTextTheme.bodyMedium?.copyWith(
      height: 1.2,
      letterSpacing: 0,
    ),
    bodySmall: baseTextTheme.bodySmall?.copyWith(height: 1.2, letterSpacing: 0),
    labelLarge: baseTextTheme.labelLarge?.copyWith(
      height: 1.2,
      letterSpacing: 0,
    ),
    labelMedium: baseTextTheme.labelMedium?.copyWith(
      height: 1.2,
      letterSpacing: 0,
    ),
    labelSmall: baseTextTheme.labelSmall?.copyWith(
      height: 1.2,
      letterSpacing: 0,
    ),
  );
  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    scaffoldBackgroundColor: colors.background,
    canvasColor: colors.background,
    splashFactory: NoSplash.splashFactory,
    highlightColor: Colors.transparent,
    colorScheme: ColorScheme(
      brightness: brightness,
      primary: colors.brand,
      onPrimary: colors.onBrand,
      secondary: colors.link,
      onSecondary: colors.onBrand,
      error: colors.blocked,
      onError: colors.onBrand,
      surface: colors.level1,
      onSurface: colors.foreground,
    ),
    textTheme: textTheme.apply(
      bodyColor: colors.foreground,
      displayColor: colors.foreground,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: colors.level2,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: BorderSide.none,
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: BorderSide.none,
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: BorderSide(color: colors.brand, width: 1.5),
      ),
    ),
    extensions: [colors],
  );
}

abstract final class IrisType {
  static const title = TextStyle(
    fontSize: 32,
    fontWeight: FontWeight.w700,
    height: 1.15,
    letterSpacing: -0.8,
  );
  static const rowTitle = TextStyle(
    fontSize: 17,
    fontWeight: FontWeight.w600,
    height: 20 / 17,
    letterSpacing: -0.204,
  );
  static const body = TextStyle(
    fontSize: 17,
    fontWeight: FontWeight.w400,
    height: 1.55,
    letterSpacing: -0.17,
  );
  static const label = TextStyle(
    fontSize: 15,
    fontWeight: FontWeight.w600,
    height: 18 / 15,
    letterSpacing: -0.075,
  );
  static const meta = TextStyle(
    fontSize: 13,
    fontWeight: FontWeight.w400,
    height: 16 / 13,
  );
  static const mono = TextStyle(
    fontFamily: 'monospace',
    fontSize: 14,
    fontWeight: FontWeight.w400,
    height: 1.5,
  );
}

// 폰 하단 시스템 영역(3버튼 내비게이션·제스처 막대) 위 간격. 버튼·입력칸이 막대에 붙지 않게
const irisBottomGap = 10.0;

// 하단 막대가 있으면 그 높이 + 간격, 없으면 0
double irisBottomInset(BuildContext context) {
  final system = MediaQuery.paddingOf(context).bottom;
  return system > 0 ? system + irisBottomGap : 0;
}
