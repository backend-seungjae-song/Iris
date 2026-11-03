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

// 세션 줄 상태 표식. 색 원 안에 상태별 모양(20 격자). working 은 호가 1.1초에 한 바퀴
class IrisStatusGlyph extends StatefulWidget {
  const IrisStatusGlyph({required this.status, this.size = 18, super.key});

  final String status;
  final double size;

  @override
  State<IrisStatusGlyph> createState() => _IrisStatusGlyphState();
}

class _IrisStatusGlyphState extends State<IrisStatusGlyph>
    with TickerProviderStateMixin {
  AnimationController? _spin;

  void _sync(bool animate) {
    final moves = animate && widget.status == 'working';
    if (!moves) {
      _spin?.dispose();
      _spin = null;
    } else {
      _spin ??= AnimationController(
        vsync: this,
        duration: const Duration(milliseconds: 1100),
      )..repeat();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync(!MediaQuery.disableAnimationsOf(context));
  }

  @override
  void didUpdateWidget(IrisStatusGlyph oldWidget) {
    super.didUpdateWidget(oldWidget);
    _sync(!MediaQuery.disableAnimationsOf(context));
  }

  @override
  void dispose() {
    _spin?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final spin = _spin;
    Widget paint(double turn) => CustomPaint(
      size: Size.square(widget.size),
      painter: _GlyphPainter(widget.status, colors, turn),
    );
    return Semantics(
      label: _label(widget.status),
      child: spin == null
          ? paint(0)
          : AnimatedBuilder(
              animation: spin,
              builder: (_, _) => paint(spin.value),
            ),
    );
  }
}

class _GlyphPainter extends CustomPainter {
  _GlyphPainter(this.status, this.colors, this.turn);

  final String status;
  final IrisColors colors;
  final double turn;

  @override
  void paint(Canvas canvas, Size size) {
    final k = size.width / 20;
    Offset p(double x, double y) => Offset(x * k, y * k);
    Paint stroke(Color color, double width) => Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = width * k
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    final fill = switch (status) {
      'working' => colors.sky,
      'done' => colors.mint,
      'blocked' => colors.pink,
      'question' => colors.yellow,
      _ => null,
    };
    if (fill == null) {
      canvas.drawCircle(p(10, 10), 8 * k, stroke(colors.muted, 1.8));
      return;
    }
    canvas.drawCircle(p(10, 10), 9 * k, Paint()..color = fill);
    final ink = colors.ink;
    switch (status) {
      case 'working':
        canvas.save();
        canvas.translate(10 * k, 10 * k);
        canvas.rotate(turn * 2 * math.pi);
        canvas.translate(-10 * k, -10 * k);
        canvas.drawArc(
          Rect.fromCircle(center: p(10, 10), radius: 5 * k),
          -math.pi / 2,
          math.pi * 1.5,
          false,
          stroke(ink, 2.2),
        );
        canvas.restore();
      case 'done':
        canvas.drawPath(
          Path()
            ..moveTo(6 * k, 10.2 * k)
            ..lineTo(8.8 * k, 13 * k)
            ..lineTo(14 * k, 7.4 * k),
          stroke(ink, 2.2),
        );
      case 'blocked':
        final bar = stroke(ink, 2.3);
        canvas.drawLine(p(7.8, 6.3), p(7.8, 13.7), bar);
        canvas.drawLine(p(12.2, 6.3), p(12.2, 13.7), bar);
      case 'question':
        canvas.drawPath(
          Path()
            ..moveTo(7.6 * k, 7.6 * k)
            ..arcToPoint(
              p(12.4, 8.5),
              radius: Radius.circular(2.5 * k),
              largeArc: false,
            )
            ..cubicTo(
              p(12.4, 10.1).dx,
              p(12.4, 10.1).dy,
              p(10, 10.5).dx,
              p(10, 10.5).dy,
              10 * k,
              11.8 * k,
            ),
          stroke(ink, 2),
        );
        canvas.drawCircle(p(10, 14.6), 1.1 * k, Paint()..color = ink);
    }
  }

  @override
  bool shouldRepaint(_GlyphPainter old) =>
      old.status != status || old.colors != colors || old.turn != turn;
}

// 에이전트 종류 이름표. 모노 글자 11.5, 높이 20, 모서리 6, 앞에 7px 색 점
class IrisKindTag extends StatelessWidget {
  const IrisKindTag({required this.kind, super.key});

  final String kind;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final (label, dot) = switch (kind) {
      'claude' => ('Claude', colors.sky),
      'codex' => ('Codex', colors.lime),
      'terminal' => ('터미널', colors.teal),
      _ => (kind, colors.mint),
    };
    return Container(
      height: 20,
      padding: const EdgeInsets.symmetric(horizontal: 6),
      decoration: BoxDecoration(
        border: Border.all(color: dot.withValues(alpha: 0.4)),
        borderRadius: BorderRadius.circular(IrisRadius.small),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(
              color: dot,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          const SizedBox(width: 5),
          Text(
            label,
            style: TextStyle(
              color: dot,
              fontFamily: 'monospace',
              fontSize: 11.5,
              fontWeight: FontWeight.w500,
              height: 1,
            ),
          ),
        ],
      ),
    );
  }
}
