import 'package:flutter/material.dart';

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
  });

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
  final Color working;
  final Color done;
  final Color idle;
  final Color blocked;
  final Color question;
  final Color terminal;

  static const dark = IrisColors(
    background: Color(0xff070e14),
    level1: Color(0xff0e1a24),
    level2: Color(0xff152532),
    level3: Color(0xff1d3140),
    separator: Color(0x12a6daf4),
    foreground: Color(0xffeaf3fa),
    foreground2: Color(0xffb9cbd8),
    muted: Color(0xff8199aa),
    faint: Color(0xff58717f),
    brand: Color(0xffa6daf4),
    onBrand: Color(0xff06121b),
    link: Color(0xff8fd0f2),
    working: Color(0xff8bfbc2),
    done: Color(0xff00aff0),
    idle: Color(0xff58717f),
    blocked: Color(0xffff7a72),
    question: Color(0xfff9f871),
    terminal: Color(0xff08121a),
  );

  static const light = IrisColors(
    background: Color(0xfff4f8fb),
    level1: Color(0xffffffff),
    level2: Color(0xffe7f0f7),
    level3: Color(0xffd9e8f3),
    separator: Color(0x140a1620),
    foreground: Color(0xff0a1620),
    foreground2: Color(0xff2a4354),
    muted: Color(0xff56717f),
    faint: Color(0xff859cab),
    brand: Color(0xff0b6fa4),
    onBrand: Color(0xffffffff),
    link: Color(0xff0b6fa4),
    working: Color(0xff23875a),
    done: Color(0xff0b86bd),
    idle: Color(0xff859cab),
    blocked: Color(0xffd9443a),
    question: Color(0xff8a6a00),
    terminal: Color(0xff08121a),
  );

  @override
  IrisColors copyWith() => this;

  @override
  IrisColors lerp(covariant ThemeExtension<IrisColors>? other, double t) =>
      this;
}

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
