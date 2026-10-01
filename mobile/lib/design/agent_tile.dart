import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:iris_remote/design/logo.dart';
import 'package:iris_remote/design/tokens.dart';

class IrisStatusDot extends StatelessWidget {
  const IrisStatusDot({required this.status, this.size = 9, super.key});

  final String status;
  final double size;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final question = status == 'question';
    final blocked = status == 'blocked';
    final idle = status == 'idle' || status == 'unknown';
    final color = switch (status) {
      'working' => colors.working,
      'done' => colors.done,
      'blocked' => colors.blocked,
      'question' => colors.question,
      _ => colors.idle,
    };
    final dot = Container(
      width: question ? size - 1 : size,
      height: question ? size - 1 : size,
      decoration: BoxDecoration(
        color: idle ? Colors.transparent : color,
        border: idle ? Border.all(color: color, width: 1.5) : null,
        borderRadius: BorderRadius.circular(
          question ? 1.5 : (blocked ? 2 : size / 2),
        ),
      ),
    );
    return Semantics(
      label: _label(status),
      child: question ? Transform.rotate(angle: math.pi / 4, child: dot) : dot,
    );
  }
}

class IrisAgentTile extends StatelessWidget {
  const IrisAgentTile({
    required this.kind,
    required this.status,
    this.small = false,
    this.statusKey,
    super.key,
  });

  final String kind;
  final String status;
  final bool small;
  final Key? statusKey;

  @override
  Widget build(BuildContext context) {
    final tileSize = small ? 30.0 : 44.0;
    final badgeSize = small ? 13.0 : 18.0;
    final dotSize = small ? 6.0 : 9.0;
    return SizedBox.square(
      dimension: tileSize,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Container(
            width: tileSize,
            height: tileSize,
            decoration: BoxDecoration(
              color: context.iris.level2,
              borderRadius: BorderRadius.circular(small ? 9 : 12),
            ),
            child: IconTheme(
              data: IconThemeData(color: context.iris.foreground),
              child: Center(
                child: IrisAgentLogo(kind: kind, size: small ? 16 : 22),
              ),
            ),
          ),
          if (kind != 'terminal')
            Positioned(
              right: small ? -3 : -4,
              bottom: small ? -3 : -4,
              child: Container(
                width: badgeSize,
                height: badgeSize,
                decoration: BoxDecoration(
                  color: context.iris.background,
                  borderRadius: BorderRadius.circular(badgeSize / 2),
                ),
                child: Center(
                  child: IrisStatusDot(
                    key: statusKey,
                    status: status,
                    size: dotSize,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

String _label(String status) => switch (status) {
  'working' => '작업 중',
  'done' => '작업 완료',
  'blocked' => '허용 대기',
  'question' => '질문 있음',
  'idle' => '비활성화',
  _ => '상태 알 수 없음',
};
