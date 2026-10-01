import 'dart:async';

import 'package:flutter/material.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/flow.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/session.dart';

class CodeScreen extends StatefulWidget {
  const CodeScreen({required this.pending, required this.onConfirm, super.key});

  final PendingPairing pending;
  final Future<void> Function() onConfirm;

  @override
  State<CodeScreen> createState() => _CodeScreenState();
}

class _CodeScreenState extends State<CodeScreen> {
  bool _busy = false;
  String? _error;
  DateTime? _retryUntil;
  Timer? _retryTimer;

  int get _retrySeconds {
    final until = _retryUntil;
    if (until == null) return 0;
    final milliseconds = until.difference(DateTime.now()).inMilliseconds;
    return milliseconds <= 0 ? 0 : (milliseconds / 1000).ceil();
  }

  @override
  void dispose() {
    _retryTimer?.cancel();
    super.dispose();
  }

  void _showFailure(RemoteFailure error) {
    _retryTimer?.cancel();
    _retryUntil = null;
    final retryAfter = error.retryAfter;
    if (retryAfter != null && retryAfter > Duration.zero) {
      _retryUntil = DateTime.now().add(retryAfter);
      _retryTimer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (!mounted) return;
        if (_retrySeconds == 0) {
          _retryTimer?.cancel();
          _retryTimer = null;
          _retryUntil = null;
        }
        setState(() {});
      });
    }
    setState(() => _error = error.message);
  }

  Future<void> _confirm() async {
    if (_retrySeconds > 0) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.onConfirm();
      if (mounted) Navigator.of(context).pop();
    } on RemoteFailure catch (error) {
      if (mounted) _showFailure(error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final retrySeconds = _retrySeconds;
    final error = _error;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            IrisFlowHeader(
              title: '폰 등록',
              onBack: () => Navigator.of(context).pop(),
            ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 20, 20, 28),
                child: Column(
                  children: [
                    const Spacer(),
                    Text(
                      widget.pending.code,
                      key: const Key('code-value'),
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: context.iris.foreground,
                        fontSize: 56,
                        fontWeight: FontWeight.w700,
                        height: 1,
                        letterSpacing: 8,
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                    ),
                    const SizedBox(height: 24),
                    Text(
                      'Mac의 Iris 원격 화면에 이 코드를 입력하세요',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: context.iris.foreground2,
                        fontSize: 17,
                        height: 1.5,
                      ),
                    ),
                    if (error != null) ...[
                      const SizedBox(height: 20),
                      Text(
                        retrySeconds > 0
                            ? '$error · $retrySeconds초 후 다시 시도하세요.'
                            : error,
                        textAlign: TextAlign.center,
                        style: TextStyle(color: context.iris.blocked),
                      ),
                    ],
                    const Spacer(),
                    Row(
                      children: [
                        IrisButton(
                          key: const Key('code-confirm'),
                          label: _busy
                              ? '연결 확인 중…'
                              : retrySeconds > 0
                              ? '$retrySeconds초 후 다시 시도'
                              : 'Mac에 입력했습니다',
                          tone: IrisButtonTone.primary,
                          height: 58,
                          onPressed: _busy || retrySeconds > 0
                              ? null
                              : _confirm,
                        ),
                      ],
                    ),
                    if (error != null) ...[
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          IrisButton(
                            label: '다시 시도',
                            onPressed: _busy || retrySeconds > 0
                                ? null
                                : _confirm,
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
