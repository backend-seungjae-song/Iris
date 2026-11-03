import 'dart:async';

import 'package:flutter/material.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/diagnostics/app_log.dart';
import 'package:iris_remote/design/tokens.dart';

enum IrisToastTone { ok, error }

OverlayEntry? _activeToast;
Timer? _activeToastTimer;

// 완료·오류 토스트 .toast. 한 번에 하나만 표시하고 새 토스트가 이전 것을 바꿈
void showIrisToast(
  BuildContext context,
  String message, {
  IrisToastTone tone = IrisToastTone.ok,
  Duration duration = const Duration(milliseconds: 2200),
}) {
  AppLog.write('toast', '${tone.name} $message');
  final overlay = Overlay.maybeOf(context, rootOverlay: true);
  if (overlay == null) return;
  _activeToastTimer?.cancel();
  _activeToast?.remove();
  final visible = ValueNotifier<bool>(true);
  late final OverlayEntry entry;
  entry = OverlayEntry(
    builder: (_) => _IrisToast(message: message, tone: tone, visible: visible),
  );
  _activeToast = entry;
  overlay.insert(entry);
  _activeToastTimer = Timer(duration, () {
    visible.value = false;
    // 퇴장 전환(200ms) 뒤에 제거
    _activeToastTimer = Timer(const Duration(milliseconds: 260), () {
      if (_activeToast == entry) {
        entry.remove();
        _activeToast = null;
      }
      visible.dispose();
    });
  });
}

class _IrisToast extends StatelessWidget {
  const _IrisToast({
    required this.message,
    required this.tone,
    required this.visible,
  });

  final String message;
  final IrisToastTone tone;
  final ValueNotifier<bool> visible;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    // 시안 bottom 96 에서 하단 제스처 막대 20 을 뺀 값 + 시스템 하단 영역(20 이상)
    final system = MediaQuery.paddingOf(context).bottom;
    final bottom = 76.0 + (system > 20 ? system : 20.0);
    final iconColor = tone == IrisToastTone.ok
        ? colors.okText
        : colors.dangerText;
    return Positioned(
      left: 16,
      right: 16,
      bottom: bottom,
      child: IgnorePointer(
        child: ValueListenableBuilder<bool>(
          valueListenable: visible,
          builder: (context, show, child) => TweenAnimationBuilder<double>(
            tween: Tween(begin: 12, end: show ? 0 : 12),
            duration: const Duration(milliseconds: 240),
            curve: irisEase,
            builder: (context, dy, child) => Transform.translate(
              offset: Offset(0, dy),
              child: TweenAnimationBuilder<double>(
                tween: Tween(begin: 0, end: show ? 1 : 0),
                duration: const Duration(milliseconds: 200),
                curve: irisEase,
                builder: (context, opacity, child) =>
                    Opacity(opacity: opacity, child: child),
                child: child,
              ),
            ),
            child: child,
          ),
          child: Semantics(
            liveRegion: true,
            container: true,
            child: Material(
              type: MaterialType.transparency,
              child: Container(
                key: const Key('iris-toast'),
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 12,
                ),
                decoration: BoxDecoration(
                  color: colors.level3,
                  borderRadius: BorderRadius.circular(IrisRadius.card),
                  boxShadow: [
                    BoxShadow(
                      color: colors.shadow,
                      offset: const Offset(0, 12),
                      blurRadius: 32,
                    ),
                    BoxShadow(color: colors.shadowRing, spreadRadius: 1),
                  ],
                ),
                child: Row(
                  children: [
                    IrisIcon(
                      tone == IrisToastTone.ok ? 'check' : 'warning-circle',
                      size: 18,
                      color: iconColor,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        message,
                        style: TextStyle(
                          fontSize: 14,
                          height: 1.5,
                          color: colors.foreground,
                          decoration: TextDecoration.none,
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
    );
  }
}
