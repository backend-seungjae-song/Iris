import 'package:flutter/material.dart';
import 'package:iris_remote/design/tokens.dart';

const irisSheetRadius = 40.0;

// 시트 아래 끝 위치. 하단 막대와 키보드 위 8
double irisSheetBottom(BuildContext context) =>
    8 +
    MediaQuery.paddingOf(context).bottom +
    MediaQuery.viewInsetsOf(context).bottom;

class IrisSheetFrame extends StatelessWidget {
  const IrisSheetFrame({
    required this.child,
    this.referenceShadow = false,
    super.key,
  });

  final Widget child;
  final bool referenceShadow;

  @override
  Widget build(BuildContext context) {
    return Material(
      type: MaterialType.transparency,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          DecoratedBox(
            decoration: BoxDecoration(
              color: context.iris.level1,
              borderRadius: BorderRadius.circular(irisSheetRadius),
              boxShadow: referenceShadow
                  ? null
                  : const [
                      BoxShadow(
                        color: Color(0x66000000),
                        offset: Offset(0, -20),
                        blurRadius: 60,
                        spreadRadius: -10,
                      ),
                    ],
            ),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 24),
              child: child,
            ),
          ),
          if (referenceShadow)
            const Positioned(
              left: 24,
              right: 24,
              top: -40,
              height: 40,
              child: IgnorePointer(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [Colors.transparent, Color(0x66000000)],
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class IrisSheetGrabber extends StatelessWidget {
  const IrisSheetGrabber({this.barKey, super.key});

  final Key? barKey;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        key: barKey,
        width: 40,
        height: 5,
        decoration: BoxDecoration(
          color: context.iris.level3,
          borderRadius: BorderRadius.circular(3),
        ),
      ),
    );
  }
}

Future<T?> showIrisSheet<T>({
  required BuildContext context,
  required WidgetBuilder builder,
  Color barrierColor = const Color(0x8c020609),
}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    enableDrag: true,
    isDismissible: true,
    barrierColor: barrierColor,
    backgroundColor: Colors.transparent,
    sheetAnimationStyle: const AnimationStyle(
      duration: Duration(milliseconds: 320),
      reverseDuration: Duration(milliseconds: 320),
    ),
    builder: (context) {
      final media = MediaQuery.of(context);
      final maximumHeight =
          (media.size.height -
                  media.padding.top -
                  irisSheetBottom(context) -
                  16)
              .clamp(0.0, double.infinity);
      return Padding(
        padding: EdgeInsets.fromLTRB(8, 8, 8, irisSheetBottom(context)),
        child: ConstrainedBox(
          key: const Key('iris-sheet-bounds'),
          constraints: BoxConstraints(maxHeight: maximumHeight),
          child: IrisSheetFrame(child: builder(context)),
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
        const ColoredBox(color: Color(0x8c020609)),
        Positioned(
          left: 8,
          right: 8,
          bottom: irisSheetBottom(context),
          child: IrisSheetFrame(
            key: sheetKey,
            referenceShadow: true,
            child: sheet,
          ),
        ),
      ],
    );
  }
}
