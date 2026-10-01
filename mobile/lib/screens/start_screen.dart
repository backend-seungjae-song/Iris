import 'package:flutter/material.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/tokens.dart';

class StartScreen extends StatelessWidget {
  const StartScreen({
    required this.onScan,
    this.busy = false,
    this.error,
    super.key,
  });

  final VoidCallback onScan;
  final bool busy;
  final String? error;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(),
              Align(
                alignment: Alignment.centerLeft,
                child: Container(
                  width: 56,
                  height: 56,
                  decoration: BoxDecoration(
                    color: context.iris.level2,
                    borderRadius: BorderRadius.circular(16),
                  ),
                  alignment: Alignment.center,
                  child: IrisIcon(
                    'monitor',
                    size: 28,
                    color: context.iris.foreground2,
                  ),
                ),
              ),
              const SizedBox(height: 22),
              Text(
                'Mac과 연결',
                key: const Key('start-title'),
                style: IrisType.title.copyWith(color: context.iris.foreground),
              ),
              const SizedBox(height: 12),
              Text(
                'Mac의 Iris 원격 화면에 표시된 QR 코드를 읽어 이 폰을 등록하세요.',
                style: TextStyle(
                  color: context.iris.muted,
                  fontSize: 17,
                  height: 1.5,
                ),
              ),
              if (error != null) ...[
                const SizedBox(height: 20),
                Text(
                  error!,
                  style: TextStyle(
                    color: context.iris.blocked,
                    fontSize: 15,
                    height: 1.45,
                  ),
                ),
              ],
              const Spacer(),
              Row(
                children: [
                  IrisButton(
                    key: const Key('start-scan'),
                    label: busy ? '연결 준비 중…' : 'QR 코드 스캔',
                    icon: 'scan-smiley',
                    tone: IrisButtonTone.primary,
                    height: 58,
                    onPressed: busy ? null : onScan,
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
