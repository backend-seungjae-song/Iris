import 'package:flutter/material.dart';
import 'package:iris_remote/design/tokens.dart';

// 시트 윗모서리 반경 .sheet
const irisSheetRadius = IrisRadius.sheet;

// 하단에 띄워 두는 시트의 아래 끝 위치. 하단 막대와 키보드 위 8
double irisSheetBottom(BuildContext context) =>
    8 +
    MediaQuery.paddingOf(context).bottom +
    MediaQuery.viewInsetsOf(context).bottom;

// 시트 껍데기 .sheet. 윗모서리만 둥글고 배경 surface, 그림자 --shadow
class IrisSheetFrame extends StatelessWidget {
  const IrisSheetFrame({
    required this.child,
    this.referenceShadow = false,
    this.horizontalPadding = 16,
    this.bottomPadding = 28,
    super.key,
  });

  final Widget child;
  final bool referenceShadow;
  // 시안은 0, 내용이 자기 20 여백을 가짐. 기존 화면 호환 기본값 16
  final double horizontalPadding;
  final double bottomPadding;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Material(
      type: MaterialType.transparency,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: colors.level1,
          borderRadius: const BorderRadius.vertical(
            top: Radius.circular(irisSheetRadius),
          ),
          boxShadow: referenceShadow
              ? null
              : [
                  BoxShadow(
                    color: colors.shadow,
                    offset: const Offset(0, 12),
                    blurRadius: 32,
                  ),
                  BoxShadow(color: colors.shadowRing, spreadRadius: 1),
                ],
        ),
        child: Padding(
          padding: EdgeInsets.fromLTRB(
            horizontalPadding,
            8,
            horizontalPadding,
            bottomPadding,
          ),
          child: child,
        ),
      ),
    );
  }
}

// 손잡이 .grab. 36x4. spaced 는 시안 여백(위 4 아래 8)을 포함
class IrisSheetGrabber extends StatelessWidget {
  const IrisSheetGrabber({this.barKey, this.spaced = false, super.key});

  final Key? barKey;
  final bool spaced;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: spaced
          ? const EdgeInsets.only(top: 4, bottom: 8)
          : EdgeInsets.zero,
      child: Center(
        child: Container(
          key: barKey,
          width: 36,
          height: 4,
          decoration: BoxDecoration(
            color: context.iris.line2,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      ),
    );
  }
}

// 시트 제목 .sheet h3. 17 / 600, 안쪽 6 20 10
class IrisSheetTitle extends StatelessWidget {
  const IrisSheetTitle(this.text, {this.padding, super.key});

  final String text;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: padding ?? const EdgeInsets.fromLTRB(20, 6, 20, 10),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 17,
          fontWeight: FontWeight.w600,
          color: context.iris.foreground,
        ),
      ),
    );
  }
}

// 화면 아래에 붙는 시트. 좌우·아래 여백 없음, 시스템 하단 영역은 아래 패딩에 더함
Future<T?> showIrisSheet<T>({
  required BuildContext context,
  required WidgetBuilder builder,
  Color? barrierColor,
  double horizontalPadding = 16,
}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    enableDrag: true,
    isDismissible: true,
    barrierColor: barrierColor ?? context.iris.scrim,
    backgroundColor: Colors.transparent,
    sheetAnimationStyle: const AnimationStyle(
      duration: Duration(milliseconds: 300),
      reverseDuration: Duration(milliseconds: 300),
      curve: irisEaseDrawer,
      reverseCurve: irisEaseDrawer,
    ),
    builder: (context) {
      final media = MediaQuery.of(context);
      final maximumHeight = (media.size.height - media.padding.top - 16).clamp(
        0.0,
        double.infinity,
      );
      return Padding(
        padding: EdgeInsets.only(bottom: media.viewInsets.bottom),
        child: ConstrainedBox(
          key: const Key('iris-sheet-bounds'),
          constraints: BoxConstraints(maxHeight: maximumHeight),
          child: IrisSheetFrame(
            horizontalPadding: horizontalPadding,
            bottomPadding: 28 + media.padding.bottom,
            child: builder(context),
          ),
        ),
      );
    },
  );
}

class IrisSheetScene extends StatelessWidget {
  const IrisSheetScene({
    required this.background,
    required this.sheet,
    this.sheetKey,
    super.key,
  });

  final Widget background;
  final Widget sheet;
  final Key? sheetKey;

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        background,
        ColoredBox(color: context.iris.scrim),
        Positioned(
          left: 0,
          right: 0,
          bottom: 0,
          child: IrisSheetFrame(
            key: sheetKey,
            referenceShadow: true,
            bottomPadding: 28 + MediaQuery.paddingOf(context).bottom,
            child: sheet,
          ),
        ),
      ],
    );
  }
}
