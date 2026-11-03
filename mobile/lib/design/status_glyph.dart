import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:iris_remote/design/tokens.dart';

// 대화 화면 상태 모양. 시안 .sg (viewBox 20): 색 원판 + 어두운 기호
// status: working | done | blocked | question | idle(그 외)
class IrisStatusGlyph extends StatefulWidget {
  const IrisStatusGlyph({
    required this.status,
    this.size = 16,
    this.animate = true,
    super.key,
  });

  final String status;
  final double size;
  final bool animate;

  @override
  State<IrisStatusGlyph> createState() => _IrisStatusGlyphState();
}

class _IrisStatusGlyphState extends State<IrisStatusGlyph>
    with TickerProviderStateMixin {
  AnimationController? _controller;

  bool _reduceMotion = false;

  bool get _spins =>
      widget.animate && !_reduceMotion && widget.status == 'working';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduceMotion = MediaQuery.disableAnimationsOf(context);
    _sync();
  }

  @override
  void didUpdateWidget(covariant IrisStatusGlyph oldWidget) {
    super.didUpdateWidget(oldWidget);
    _sync();
  }

  // 작업 중일 때만 회전 1.1초
  void _sync() {
    if (_spins && _controller == null) {
      _controller = AnimationController(
        vsync: this,
        duration: const Duration(milliseconds: 1100),
      )..repeat();
    } else if (!_spins && _controller != null) {
      _controller!.dispose();
      _controller = null;
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
    final light = Theme.of(context).brightness == Brightness.light;
    return Semantics(
      label: switch (widget.status) {
        'working' => '작업 중',
        'done' => '완료',
        'blocked' => '멈춤',
        'question' => '질문',
        _ => '대기',
      },
      child: CustomPaint(
        size: Size.square(widget.size),
        painter: _GlyphPainter(
          status: widget.status,
          colors: colors,
          edge: light,
          turns: _controller,
        ),
      ),
    );
  }
}

class _GlyphPainter extends CustomPainter {
  _GlyphPainter({
    required this.status,
    required this.colors,
    required this.edge,
    required this.turns,
  }) : super(repaint: turns);

  final String status;
  final IrisColors colors;
  final bool edge;
  final Animation<double>? turns;

  @override
  void paint(Canvas canvas, Size size) {
    final unit = size.width / 20;
    canvas.scale(unit);
    final ink = Paint()
      ..color = colors.ink
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    if (status == 'idle' || status == 'unknown') {
      final ring = Paint()
        ..color = colors.muted
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.8
        ..strokeCap = StrokeCap.round;
      canvas.drawCircle(const Offset(10, 10), 8, ring);
      canvas.drawLine(const Offset(6.5, 10), const Offset(13.5, 10), ring);
      return;
    }
    final fill = switch (status) {
      'working' => colors.sky,
      'done' => colors.mint,
      'blocked' => colors.pink,
      _ => colors.yellow,
    };
    canvas.drawCircle(const Offset(10, 10), 9, Paint()..color = fill);
    if (edge) {
      canvas.drawCircle(
        const Offset(10, 10),
        9,
        Paint()
          ..color = const Color.fromRGBO(10, 28, 40, .38)
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1,
      );
    }
    switch (status) {
      case 'working':
        canvas.save();
        canvas.translate(10, 10);
        canvas.rotate((turns?.value ?? 0) * 2 * math.pi);
        canvas.translate(-10, -10);
        canvas.drawArc(
          Rect.fromCircle(center: const Offset(10, 10), radius: 5),
          -math.pi / 2,
          math.pi * 1.5,
          false,
          ink..strokeWidth = 2.2,
        );
        canvas.restore();
      case 'done':
        canvas.drawPath(
          Path()
            ..moveTo(6, 10.3)
            ..lineTo(8.7, 13)
            ..lineTo(14.2, 7.4),
          ink..strokeWidth = 2.2,
        );
      case 'blocked':
        ink.strokeWidth = 2.3;
        canvas.drawLine(const Offset(7.8, 6.3), const Offset(7.8, 13.7), ink);
        canvas.drawLine(const Offset(12.2, 6.3), const Offset(12.2, 13.7), ink);
      default:
        canvas.drawPath(
          Path()
            ..moveTo(7.6, 7.6)
            ..arcToPoint(
              const Offset(12.4, 8.5),
              radius: const Radius.circular(2.5),
            )
            ..cubicTo(12.4, 10.1, 10, 10.5, 10, 11.8),
          ink..strokeWidth = 2,
        );
        canvas.drawCircle(
          const Offset(10, 14.6),
          1.1,
          Paint()..color = colors.ink,
        );
    }
  }

  @override
  bool shouldRepaint(covariant _GlyphPainter old) =>
      old.status != status || old.colors != colors || old.edge != edge;
}
