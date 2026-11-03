import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:iris_remote/design/tokens.dart';

enum IrisStatus { work, done, idle, block, q, live, off, neutral }

const _defaultLabels = {
  IrisStatus.work: '작업 중',
  IrisStatus.done: '완료',
  IrisStatus.idle: '대기',
  IrisStatus.block: '답 필요',
  IrisStatus.q: '질문 있음',
  IrisStatus.live: '실시간',
  IrisStatus.off: '연결 끊김',
};

// 상태칩 .st. 높이 22, 모양과 글자를 함께 표시
// neutral 은 label 필수. animate false 는 회전·맥동 정지(테스트용)
class IrisStatusChip extends StatelessWidget {
  const IrisStatusChip(
    this.status, {
    this.label,
    this.animate = true,
    super.key,
  }) : assert(status != IrisStatus.neutral || label != null);

  final IrisStatus status;
  final String? label;
  final bool animate;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final light = Theme.of(context).brightness == Brightness.light;
    final (Color? background, Color foreground) = switch (status) {
      IrisStatus.work => (colors.sky, colors.ink),
      IrisStatus.done => (colors.mint, colors.ink),
      IrisStatus.idle => (null, colors.foreground2),
      IrisStatus.block => (colors.pink, colors.ink),
      IrisStatus.q => (colors.yellow, colors.ink),
      IrisStatus.live => (colors.mint, colors.ink),
      IrisStatus.off => (colors.pink, colors.ink),
      IrisStatus.neutral => (colors.level3, colors.foreground),
    };
    // idle 은 테두리 line2, 라이트의 밝은 칩은 얇은 어두운 테두리
    final ring = switch (status) {
      IrisStatus.idle => colors.line2,
      IrisStatus.q ||
      IrisStatus.done ||
      IrisStatus.work ||
      IrisStatus.live when light => const Color.fromRGBO(6, 32, 46, .12),
      _ => null,
    };
    final text = label ?? _defaultLabels[status]!;
    final hasIcon = status != IrisStatus.neutral;
    return Container(
      height: 22,
      padding: EdgeInsets.only(left: hasIcon ? 6 : 8, right: 8),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(IrisRadius.pill),
      ),
      // 테두리는 크기를 차지하지 않는 안쪽 선(inset box-shadow)
      foregroundDecoration: ring == null
          ? null
          : BoxDecoration(
              borderRadius: BorderRadius.circular(IrisRadius.pill),
              border: Border.all(color: ring),
            ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (hasIcon) ...[
            _StatusGlyph(
              status: status,
              color: foreground,
              animate: animate && !MediaQuery.disableAnimationsOf(context),
            ),
            const SizedBox(width: 4),
          ],
          Text(
            text,
            maxLines: 1,
            softWrap: false,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              height: 1,
              color: foreground,
            ),
          ),
        ],
      ),
    );
  }
}

// 13x13 모양. 시안 SVG viewBox 16 을 비례 확대
class _StatusGlyph extends StatefulWidget {
  const _StatusGlyph({
    required this.status,
    required this.color,
    required this.animate,
  });

  final IrisStatus status;
  final Color color;
  final bool animate;

  @override
  State<_StatusGlyph> createState() => _StatusGlyphState();
}

class _StatusGlyphState extends State<_StatusGlyph>
    with TickerProviderStateMixin {
  AnimationController? _controller;

  bool get _moves =>
      widget.animate &&
      (widget.status == IrisStatus.work || widget.status == IrisStatus.live);

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(_StatusGlyph oldWidget) {
    super.didUpdateWidget(oldWidget);
    _sync();
  }

  // work 회전 1초, live 맥동 2초
  void _sync() {
    if (!_moves) {
      _controller?.dispose();
      _controller = null;
      return;
    }
    final duration = widget.status == IrisStatus.work
        ? const Duration(seconds: 1)
        : const Duration(seconds: 2);
    if (_controller == null) {
      _controller = AnimationController(vsync: this, duration: duration)
        ..repeat();
    } else if (_controller!.duration != duration) {
      _controller!
        ..duration = duration
        ..repeat();
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final controller = _controller;
    return SizedBox.square(
      dimension: 13,
      child: controller == null
          ? CustomPaint(
              painter: _GlyphPainter(widget.status, widget.color, colors, 0),
            )
          : AnimatedBuilder(
              animation: controller,
              builder: (context, _) => CustomPaint(
                painter: _GlyphPainter(
                  widget.status,
                  widget.color,
                  colors,
                  controller.value,
                ),
              ),
            ),
    );
  }
}

class _GlyphPainter extends CustomPainter {
  _GlyphPainter(this.status, this.color, this.colors, this.t);

  final IrisStatus status;
  final Color color;
  final IrisColors colors;
  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    final k = size.width / 16;
    Offset p(double x, double y) => Offset(x * k, y * k);
    Paint fill(Color c) => Paint()..color = c;
    Paint stroke(Color c, double w) => Paint()
      ..color = c
      ..style = PaintingStyle.stroke
      ..strokeWidth = w * k
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    switch (status) {
      case IrisStatus.work:
        canvas.drawCircle(
          p(8, 8),
          5.5 * k,
          stroke(color.withValues(alpha: .3), 2),
        );
        // 12시에서 3시까지 호를 회전
        canvas.save();
        canvas.translate(8 * k, 8 * k);
        canvas.rotate(t * 2 * math.pi);
        canvas.translate(-8 * k, -8 * k);
        canvas.drawArc(
          Rect.fromCircle(center: p(8, 8), radius: 5.5 * k),
          -math.pi / 2,
          math.pi / 2,
          false,
          stroke(color, 2),
        );
        canvas.restore();
      case IrisStatus.done:
        canvas.drawCircle(p(8, 8), 6.5 * k, fill(color));
        canvas.drawPath(
          Path()
            ..moveTo(5 * k, 8.2 * k)
            ..lineTo(7 * k, 10.2 * k)
            ..lineTo(11 * k, 6 * k),
          stroke(colors.mint, 1.8),
        );
      case IrisStatus.idle:
        _dashedCircle(canvas, p(8, 8), 5.5 * k, stroke(color, 1.6), k);
      case IrisStatus.block:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            Rect.fromLTWH(2 * k, 2 * k, 12 * k, 12 * k),
            Radius.circular(3 * k),
          ),
          fill(color),
        );
        final bar = stroke(colors.pink, 1.8);
        canvas.drawLine(p(6.3, 5.5), p(6.3, 10.5), bar);
        canvas.drawLine(p(9.7, 5.5), p(9.7, 10.5), bar);
      case IrisStatus.q:
        canvas.drawCircle(p(8, 8), 6.5 * k, fill(color));
        final mark = stroke(colors.yellow, 1.6);
        final hook = Path()
          ..moveTo(6.2 * k, 6.3 * k)
          ..arcToPoint(
            p(8.8, 8),
            radius: Radius.circular(1.9 * k),
            clockwise: true,
            largeArc: true,
          )
          ..cubicTo(
            p(8.3, 8.3).dx,
            p(8.3, 8.3).dy,
            p(8, 8.6).dx,
            p(8, 8.6).dy,
            8 * k,
            9.2 * k,
          )
          ..lineTo(8 * k, 9.5 * k);
        canvas.drawPath(hook, mark);
        canvas.drawCircle(p(8, 11.4), .9 * k, fill(colors.yellow));
      case IrisStatus.live:
        // 맥동: 2초 주기, 50% 지점에서 투명도 .35
        final pulse = 1 - (1 - .35) * (1 - (2 * t - 1).abs());
        canvas.drawCircle(p(8, 8), 4 * k, fill(color.withValues(alpha: pulse)));
      case IrisStatus.off:
        final x = stroke(color, 2);
        canvas.drawLine(p(4, 4), p(12, 12), x);
        canvas.drawLine(p(12, 4), p(4, 12), x);
      case IrisStatus.neutral:
        break;
    }
  }

  // stroke-dasharray 2.6 2.2 (viewBox 단위)
  void _dashedCircle(
    Canvas canvas,
    Offset center,
    double radius,
    Paint paint,
    double k,
  ) {
    final circumference = 2 * math.pi * radius;
    final dash = 2.6 * k;
    final gap = 2.2 * k;
    var at = 0.0;
    while (at < circumference) {
      final start = at / radius;
      final sweep = math.min(dash, circumference - at) / radius;
      canvas.drawArc(
        Rect.fromCircle(center: center, radius: radius),
        start,
        sweep,
        false,
        paint..strokeCap = StrokeCap.butt,
      );
      at += dash + gap;
    }
  }

  @override
  bool shouldRepaint(_GlyphPainter old) =>
      old.status != status ||
      old.color != color ||
      old.t != t ||
      old.colors != colors;
}
