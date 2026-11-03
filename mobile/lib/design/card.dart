import 'package:flutter/material.dart';
import 'package:iris_remote/design/tokens.dart';

// 카드 .card. surface 면, 반경 14, 안쪽 1px line 테두리. 패딩은 내용이 정함
class IrisCard extends StatelessWidget {
  const IrisCard({
    required this.child,
    this.padding = EdgeInsets.zero,
    this.margin,
    this.onTap,
    super.key,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final EdgeInsetsGeometry? margin;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final radius = BorderRadius.circular(IrisRadius.card);
    final card = DecoratedBox(
      decoration: BoxDecoration(
        color: colors.level1,
        borderRadius: radius,
        border: Border.all(
          color: colors.separator,
          strokeAlign: BorderSide.strokeAlignInside,
        ),
      ),
      child: ClipRRect(
        borderRadius: radius,
        child: Padding(padding: padding, child: child),
      ),
    );
    final tappable = onTap == null
        ? card
        : GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: onTap,
            child: card,
          );
    return margin == null
        ? tappable
        : Padding(padding: margin!, child: tappable);
  }
}
