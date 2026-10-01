import 'package:flutter/material.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/tokens.dart';

class IrisFlowHeader extends StatelessWidget {
  const IrisFlowHeader({required this.title, this.onBack, super.key});

  final String title;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 58,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        child: Row(
          children: [
            if (onBack != null)
              IrisRoundButton(
                icon: 'caret-left',
                tooltip: '뒤로',
                onPressed: onBack,
              )
            else
              const SizedBox(width: 40),
            Expanded(
              child: Text(
                title,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                  height: 20 / 17,
                  letterSpacing: -0.17,
                ),
              ),
            ),
            const SizedBox(width: 40),
          ],
        ),
      ),
    );
  }
}

class IrisConnectionPanel extends StatelessWidget {
  const IrisConnectionPanel({
    required this.title,
    required this.message,
    required this.actionLabel,
    required this.onAction,
    this.icon = 'wifi-slash',
    this.busy = false,
    super.key,
  });

  final String title;
  final String message;
  final String actionLabel;
  final VoidCallback? onAction;
  final String icon;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 18, 16, 0),
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: context.iris.level1,
        borderRadius: BorderRadius.circular(22),
      ),
      child: Column(
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: context.iris.level2,
                  borderRadius: BorderRadius.circular(18),
                ),
                alignment: Alignment.center,
                child: IrisIcon(
                  icon,
                  size: 18,
                  color: context.iris.foreground2,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: IrisType.rowTitle.copyWith(
                        color: context.iris.foreground,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      message,
                      style: TextStyle(
                        color: context.iris.muted,
                        fontSize: 15,
                        height: 1.5,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              IrisButton(
                label: busy ? '연결 중…' : actionLabel,
                tone: IrisButtonTone.primary,
                onPressed: busy ? null : onAction,
              ),
            ],
          ),
        ],
      ),
    );
  }
}
