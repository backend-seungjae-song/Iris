import 'package:flutter/material.dart';
import 'package:iris_remote/design/tokens.dart';

class IrisSegment<T> {
  const IrisSegment({required this.value, required this.label, this.count});

  final T value;
  final String label;
  final int? count;
}

// 세그먼트 .seg. 바깥 패딩 3, 칸 높이 38, 칸 사이 2, 알약
class IrisSegmented<T> extends StatelessWidget {
  const IrisSegmented({
    required this.segments,
    required this.value,
    required this.onChanged,
    super.key,
  });

  final List<IrisSegment<T>> segments;
  final T value;
  final ValueChanged<T> onChanged;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: colors.level2,
        borderRadius: BorderRadius.circular(IrisRadius.pill),
      ),
      foregroundDecoration: BoxDecoration(
        borderRadius: BorderRadius.circular(IrisRadius.pill),
        border: Border.all(color: colors.separator),
      ),
      child: Row(
        children: [
          for (final (index, segment) in segments.indexed) ...[
            if (index > 0) const SizedBox(width: 2),
            Expanded(
              child: Semantics(
                button: true,
                selected: segment.value == value,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => onChanged(segment.value),
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 160),
                    curve: irisEase,
                    height: 38,
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: segment.value == value
                          ? (dark ? colors.level3 : colors.level1)
                          : Colors.transparent,
                      borderRadius: BorderRadius.circular(IrisRadius.pill),
                      boxShadow: segment.value == value
                          ? const [
                              BoxShadow(
                                color: Color.fromRGBO(0, 0, 0, .18),
                                offset: Offset(0, 1),
                                blurRadius: 2,
                              ),
                            ]
                          : null,
                    ),
                    foregroundDecoration: segment.value == value
                        ? BoxDecoration(
                            borderRadius: BorderRadius.circular(
                              IrisRadius.pill,
                            ),
                            border: Border.all(color: colors.line2),
                          )
                        : null,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Flexible(
                          child: Text(
                            segment.label,
                            maxLines: 1,
                            softWrap: false,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 13.5,
                              fontWeight: FontWeight.w600,
                              color: segment.value == value
                                  ? colors.foreground
                                  : colors.muted,
                            ),
                          ),
                        ),
                        if (segment.count != null) ...[
                          const SizedBox(width: 6),
                          Text(
                            '${segment.count}',
                            style: TextStyle(
                              fontSize: 13.5,
                              fontWeight: FontWeight.w500,
                              color: colors.muted,
                            ),
                          ),
                        ],
                      ],
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
