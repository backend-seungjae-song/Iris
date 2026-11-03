import 'package:flutter/material.dart';
import 'package:iris_remote/design/tokens.dart';

// 드물게 일어나는 전환에만 쓰는 짧은 모션. OS 동작 줄이기 설정과 무관하게 실행
const irisFadeDuration = Duration(milliseconds: 160);
const irisEnterDuration = Duration(milliseconds: 200);
const irisSwapDuration = Duration(milliseconds: 180);
const irisSlideOffset = 8.0;

// 나타날 때 한 번 페이드, offset 이 0 이 아니면 아래에서 위로 이동
// enabled false 는 처음부터 최종 상태
class IrisFadeIn extends StatefulWidget {
  const IrisFadeIn({
    required this.child,
    this.duration = irisFadeDuration,
    this.offset = 0,
    this.enabled = true,
    super.key,
  });

  final Widget child;
  final Duration duration;
  final double offset;
  final bool enabled;

  @override
  State<IrisFadeIn> createState() => _IrisFadeInState();
}

class _IrisFadeInState extends State<IrisFadeIn>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: widget.duration,
    value: widget.enabled ? 0 : 1,
  );
  late final Animation<double> _curve = CurvedAnimation(
    parent: _controller,
    curve: irisEase,
  );

  @override
  void initState() {
    super.initState();
    if (widget.enabled) _controller.forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: _curve,
      child: widget.offset == 0
          ? widget.child
          : AnimatedBuilder(
              animation: _curve,
              builder: (context, child) => Transform.translate(
                offset: Offset(0, widget.offset * (1 - _curve.value)),
                child: child,
              ),
              child: widget.child,
            ),
    );
  }
}

// registry 에 id 가 처음 들어갈 때만 FadeIn 실행
// 스크롤로 다시 만들어져도 id 가 이미 있으면 모션 없음
class IrisEnterOnce extends StatefulWidget {
  const IrisEnterOnce({
    required this.registry,
    required this.id,
    required this.child,
    super.key,
  });

  final Set<String> registry;
  final String id;
  final Widget child;

  @override
  State<IrisEnterOnce> createState() => _IrisEnterOnceState();
}

class _IrisEnterOnceState extends State<IrisEnterOnce> {
  late final bool _play = widget.registry.add(widget.id);

  @override
  Widget build(BuildContext context) => IrisFadeIn(
    enabled: _play,
    duration: irisEnterDuration,
    offset: irisSlideOffset,
    child: widget.child,
  );
}

// value 가 바뀔 때 한 번 커졌다 돌아오는 스케일
class IrisPulse extends StatefulWidget {
  const IrisPulse({required this.value, required this.child, super.key});

  final Object value;
  final Widget child;

  @override
  State<IrisPulse> createState() => _IrisPulseState();
}

class _IrisPulseState extends State<IrisPulse>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: irisFadeDuration,
  );
  late final Animation<double> _scale = TweenSequence<double>([
    TweenSequenceItem(tween: Tween(begin: 1.0, end: 1.2), weight: 1),
    TweenSequenceItem(tween: Tween(begin: 1.2, end: 1.0), weight: 1),
  ]).animate(CurvedAnimation(parent: _controller, curve: irisEase));

  @override
  void didUpdateWidget(IrisPulse oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.value != widget.value) _controller.forward(from: 0);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      ScaleTransition(scale: _scale, child: widget.child);
}
