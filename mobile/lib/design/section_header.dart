import 'package:flutter/material.dart';
import 'package:iris_remote/design/tokens.dart';

// 섹션 헤더 .sec. 최소 높이 44, 왼쪽 20 오른쪽 8
// count 는 제목 옆 숫자, trailing 은 오른쪽 동작(링크·아이콘 버튼)
class IrisSectionHeader extends StatelessWidget {
  const IrisSectionHeader(this.title, {this.count, this.trailing, super.key});

  final String title;
  final int? count;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 44),
      child: Padding(
        padding: const EdgeInsets.only(left: 20, right: 8),
        child: Row(
          children: [
            Expanded(
              child: Row(
                children: [
                  Flexible(
                    child: Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.13,
                        color: colors.muted,
                      ),
                    ),
                  ),
                  if (count != null) ...[
                    const SizedBox(width: 6),
                    Text(
                      '$count',
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w500,
                        letterSpacing: 0.13,
                        color: colors.muted,
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                    ),
                  ],
                ],
              ),
            ),
            if (trailing != null) ...[const SizedBox(width: 8), trailing!],
          ],
        ),
      ),
    );
  }
}
