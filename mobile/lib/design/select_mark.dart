import 'package:flutter/material.dart';
import 'package:iris_remote/design/tokens.dart';

// 선택 표시. 단일은 원, 다중은 반경 6 사각형. 선택되면 link 색으로 채우고 체크 선이 그려짐
class IrisSelectMark extends StatelessWidget {
  const IrisSelectMark({
    required this.selected,
    this.square = false,
    this.size = 20,
    this.color,
    this.loading = false,
    super.key,
  });

  final bool selected;
  final bool square;
  final double size;
  // 선택 색. 비우면 link
  final Color? color;
  // 선택·해제 전송 중: 체크 대신 돌아가는 표시
  final bool loading;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final fill = color ?? colors.link;
    return TweenAnimationBuilder<double>(
      // 로딩 중에는 채움 값을 0으로 내려 두어, 해제가 끝나 로딩이 사라질 때 체크가 되살아나 페이드되지 않게 함
      tween: Tween(end: selected && !loading ? 1 : 0),
      duration: const Duration(milliseconds: 180),
      curve: Curves.easeOutCubic,
      builder: (context, animated, _) {
        // 로딩 중에는 채움 없이 테두리만 둬서 같은 색 돌림 표시가 배경에 묻히지 않게 함
        final progress = loading ? 0.0 : animated;
        return Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: Color.lerp(Colors.transparent, fill, progress),
            borderRadius: BorderRadius.circular(square ? 6 : size / 2),
            border: Border.all(
              color: Color.lerp(colors.faint, fill, progress)!,
              width: size >= 22 ? 2 : 1.8,
            ),
          ),
          child: loading
              ? Padding(
                  padding: EdgeInsets.all(size * 0.2),
                  child: CircularProgressIndicator(
                    key: const Key('select-mark-loading'),
                    strokeWidth: 2,
                    color: fill,
                  ),
                )
              : CustomPaint(
                  painter: _TickPainter(
                    progress: progress,
                    color: colors.background,
                  ),
                ),
        );
      },
    );
  }
}

class _TickPainter extends CustomPainter {
  const _TickPainter({required this.progress, required this.color});

  final double progress;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    if (progress <= 0) return;
    final path = Path()
      ..moveTo(size.width * 0.27, size.height * 0.52)
      ..lineTo(size.width * 0.44, size.height * 0.68)
      ..lineTo(size.width * 0.73, size.height * 0.33);
    final metric = path.computeMetrics().first;
    canvas.drawPath(
      metric.extractPath(0, metric.length * progress),
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = size.width * 0.12
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round,
    );
  }

  @override
  bool shouldRepaint(_TickPainter old) =>
      old.progress != progress || old.color != color;
}
