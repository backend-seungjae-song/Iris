import 'package:flutter/material.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/motion.dart';
import 'package:iris_remote/design/tokens.dart';

// 터미널 시안(dir-9, 세션 줄은 dir-7)의 작은 부품. 값은 시안 CSS 수치

// 상단 막대 아이콘 버튼 .ibtn. 44x44, 반경 12
class TerminalIconButton extends StatelessWidget {
  const TerminalIconButton({
    required this.tooltip,
    required this.onPressed,
    this.icon,
    this.child,
    this.background,
    this.ring = false,
    this.size = 22,
    super.key,
  });

  final String tooltip;
  final VoidCallback? onPressed;
  final String? icon;
  final Widget? child;
  final Color? background;
  // .vscroll 버튼의 바깥 1px 테두리
  final bool ring;
  final double size;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final enabled = onPressed != null;
    return Tooltip(
      message: tooltip,
      child: Opacity(
        opacity: enabled ? 1 : .38,
        child: SizedBox.square(
          dimension: 44,
          child: Material(
            color: background ?? Colors.transparent,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
              side: ring ? BorderSide(color: colors.line2) : BorderSide.none,
            ),
            child: InkWell(
              customBorder: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              onTap: onPressed,
              child: Center(
                child:
                    child ??
                    IrisIcon(icon!, size: size, color: colors.foreground2),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// 돋보기 아이콘. 24 격자 원 r7, 손잡이, 가로선(작게)·세로선(크게)
class TerminalZoomIcon extends StatelessWidget {
  const TerminalZoomIcon({required this.plus, this.size = 22, super.key});

  final bool plus;
  final double size;

  @override
  Widget build(BuildContext context) => CustomPaint(
    size: Size.square(size),
    painter: _ZoomPainter(plus, context.iris.foreground2),
  );
}

class _ZoomPainter extends CustomPainter {
  const _ZoomPainter(this.plus, this.color);
  final bool plus;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final unit = size.width / 24;
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.8 * unit
      ..strokeCap = StrokeCap.round;
    Offset at(double x, double y) => Offset(x * unit, y * unit);
    canvas.drawCircle(at(11, 11), 7 * unit, paint);
    canvas.drawLine(at(20, 20), at(16.5, 16.5), paint);
    canvas.drawLine(at(8, 11), at(14, 11), paint);
    if (plus) canvas.drawLine(at(11, 8), at(11, 14), paint);
  }

  @override
  bool shouldRepaint(_ZoomPainter oldDelegate) =>
      oldDelegate.plus != plus || oldDelegate.color != color;
}

// 세션 줄 칩(dir-7 .sess button). 높이 44, 알약, 선택은 tint3 바탕 + strong 1.5 테두리
class TerminalSessionChip extends StatelessWidget {
  const TerminalSessionChip({
    required this.leading,
    required this.label,
    required this.selected,
    required this.onPressed,
    super.key,
  });

  final Widget leading;
  final String label;
  final bool selected;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: selected ? colors.tint3 : colors.level2,
        shape: StadiumBorder(
          side: BorderSide(
            color: selected ? colors.strong : colors.separator,
            width: selected ? 1.5 : 1,
          ),
        ),
        child: InkWell(
          customBorder: const StadiumBorder(),
          onTap: onPressed,
          child: Container(
            height: 44,
            padding: const EdgeInsets.fromLTRB(10, 0, 14, 0),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                SizedBox.square(dimension: 14, child: Center(child: leading)),
                const SizedBox(width: 7),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 170),
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13.5,
                      fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                      color: selected ? colors.foreground : colors.foreground2,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// 보기 전환(dir-9 .tctl .seg). 바깥 패딩 3, 칸 높이 36, 반경 12/9
class TerminalSegment extends StatelessWidget {
  const TerminalSegment({
    required this.items,
    required this.selected,
    super.key,
  });

  final List<TerminalSegmentItem> items;
  final int selected;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: colors.level2,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          for (final (index, item) in items.indexed) ...[
            if (index > 0) const SizedBox(width: 3),
            Expanded(
              child: Opacity(
                opacity: item.onPressed == null ? .4 : 1,
                child: Semantics(
                  button: true,
                  selected: index == selected,
                  child: Material(
                    color: index == selected
                        ? colors.level1
                        : Colors.transparent,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(9),
                      side: index == selected
                          ? BorderSide(color: colors.line2)
                          : BorderSide.none,
                    ),
                    child: InkWell(
                      customBorder: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(9),
                      ),
                      onTap: item.onPressed,
                      child: SizedBox(
                        height: 36,
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            item.leading,
                            const SizedBox(width: 6),
                            Flexible(
                              child: Text(
                                item.label,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 13.5,
                                  fontWeight: FontWeight.w600,
                                  color: index == selected
                                      ? colors.foreground
                                      : colors.muted,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class TerminalSegmentItem {
  const TerminalSegmentItem({
    required this.label,
    required this.leading,
    required this.onPressed,
  });
  final String label;
  final Widget leading;
  final VoidCallback? onPressed;
}

// 키 줄 버튼 .key. 높이 44, 반경 10, 모노 13/500
class TerminalKeyCap extends StatelessWidget {
  const TerminalKeyCap({
    this.label,
    this.icon,
    required this.onPressed,
    this.tooltip,
    super.key,
  });

  final String? label;
  final String? icon;
  final String? tooltip;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final cap = Material(
      color: colors.level2,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(10),
        side: BorderSide(color: colors.separator),
      ),
      child: InkWell(
        customBorder: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
        ),
        onTap: onPressed,
        child: SizedBox(
          height: 44,
          child: Center(
            child: icon != null
                ? IrisIcon(icon!, size: 18, color: colors.foreground)
                : Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Text(
                        label!,
                        maxLines: 1,
                        softWrap: false,
                        style: TextStyle(
                          fontFamily: 'monospace',
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                          color: colors.foreground,
                        ),
                      ),
                    ),
                  ),
          ),
        ),
      ),
    );
    return tooltip == null ? cap : Tooltip(message: tooltip!, child: cap);
  }
}

// 입력 줄 오른쪽 실행 버튼 .enterk. 높이 44, 반경 12, 강조색
class TerminalRunButton extends StatelessWidget {
  const TerminalRunButton({required this.onPressed, super.key});

  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Tooltip(
      message: '보내기',
      child: Material(
        color: colors.brand,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onPressed,
          child: Container(
            height: 44,
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Transform.flip(
                  flipY: true,
                  child: IrisIcon(
                    'arrow-u-up-left',
                    size: 18,
                    color: colors.onBrand,
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  '실행',
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: colors.onBrand,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// 선택 대기 알림 .detect. 높이 28, 알약, 위험색 바탕
class TerminalDetectChip extends StatelessWidget {
  const TerminalDetectChip({super.key});

  @override
  Widget build(BuildContext context) => IrisFadeIn(
    child: Container(
      height: 28,
      padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: BoxDecoration(
        color: context.iris.blocked,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IrisIcon('list-bullets', size: 14, color: terminalOnDanger),
          const SizedBox(width: 6),
          const Text(
            '선택 대기 중',
            style: TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w600,
              color: terminalOnDanger,
            ),
          ),
        ],
      ),
    ),
  );
}

// 시안 --on-danger
const terminalOnDanger = Color(0xff3A0E14);

// 글자 크기 안내 .size. 모노 11.5, 반경 6
class TerminalSizeBadge extends StatelessWidget {
  const TerminalSizeBadge({
    required this.text,
    required this.visible,
    super.key,
  });

  final String text;
  final bool visible;

  @override
  Widget build(BuildContext context) => IgnorePointer(
    child: AnimatedOpacity(
      opacity: visible ? 1 : 0,
      duration: const Duration(milliseconds: 200),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
        decoration: BoxDecoration(
          color: context.iris.level2,
          borderRadius: BorderRadius.circular(6),
        ),
        child: Text(
          text,
          style: TextStyle(
            fontFamily: 'monospace',
            fontSize: 11.5,
            color: context.iris.muted,
          ),
        ),
      ),
    ),
  );
}

// 선택 보조 패널 .assist. 윗모서리 18, 윗선 line2, 손잡이 36x4
class TerminalAssistPanel extends StatelessWidget {
  const TerminalAssistPanel({
    required this.child,
    required this.bottomInset,
    super.key,
  });

  final Widget child;
  final double bottomInset;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return ColoredBox(
      color: colors.terminal,
      child: Container(
        padding: EdgeInsets.fromLTRB(12, 6, 12, 10 + bottomInset),
        decoration: BoxDecoration(
          color: colors.level1,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(18)),
          border: Border(top: BorderSide(color: colors.line2)),
          boxShadow: [
            BoxShadow(
              color: colors.shadow,
              offset: const Offset(0, -10),
              blurRadius: 30,
            ),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 36,
              height: 4,
              margin: const EdgeInsets.fromLTRB(0, 2, 0, 8),
              decoration: BoxDecoration(
                color: colors.line2,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            Flexible(child: child),
          ],
        ),
      ),
    );
  }
}
