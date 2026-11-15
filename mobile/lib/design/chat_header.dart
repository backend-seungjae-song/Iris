import 'package:flutter/material.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/status_glyph.dart';
import 'package:iris_remote/design/tokens.dart';

// 대화 화면 머리. 앱 막대(dir-9) 오른쪽에 터미널·브라우저·GitHub 버튼 + 같은 스페이스 세션 칩
class IrisChatHeader extends StatelessWidget {
  const IrisChatHeader({
    required this.title,
    required this.subtitle,
    required this.status,
    required this.kindLabel,
    required this.chips,
    required this.onBack,
    required this.canTerminal,
    required this.canBrowser,
    required this.onTerminal,
    required this.onBrowser,
    required this.onGitHub,
    required this.githubFailed,
    super.key,
  });

  final String title;
  final String subtitle;
  final String status;
  final String? kindLabel;
  final List<Widget> chips;
  final VoidCallback onBack;
  final bool canTerminal;
  final bool canBrowser;
  final VoidCallback? onTerminal;
  final VoidCallback? onBrowser;
  final VoidCallback? onGitHub;
  final bool githubFailed;

  static String statusLabel(String status) => switch (status) {
    'working' => '작업 중',
    'done' => '완료',
    'blocked' => '멈춤',
    'question' => '질문',
    _ => '대기',
  };

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final detail = [
      statusLabel(status),
      ?kindLabel,
      if (subtitle.isNotEmpty) subtitle,
    ].join(' · ');
    return Column(
      key: const Key('session-header'),
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          height: 56,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6),
            child: Row(
              children: [
                _HeaderButton(
                  key: const Key('session-back'),
                  icon: 'arrow-left',
                  tooltip: '뒤로',
                  onPressed: onBack,
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 17,
                            fontWeight: FontWeight.w600,
                            height: 22 / 17,
                          ),
                        ),
                        Row(
                          children: [
                            IrisStatusGlyph(status: status, size: 14),
                            const SizedBox(width: 6),
                            Flexible(
                              child: Text(
                                detail,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  color: colors.muted,
                                  fontSize: 12.5,
                                  height: 18 / 12.5,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
                if (canTerminal)
                  _HeaderButton(
                    key: const Key('session-terminal'),
                    icon: 'terminal-window',
                    tooltip: '터미널로 이동',
                    onPressed: onTerminal,
                  ),
                if (canBrowser)
                  _HeaderButton(
                    key: const Key('session-browser'),
                    icon: 'globe',
                    tooltip: '브라우저로 이동',
                    onPressed: onBrowser,
                  ),
                if (onGitHub != null)
                  _HeaderButton(
                    key: const Key('session-github'),
                    icon: 'github-logo',
                    tooltip: '변경·PR',
                    onPressed: onGitHub,
                    badge: githubFailed,
                  ),
              ],
            ),
          ),
        ),
        if (chips.length > 1)
          Container(
            key: const Key('session-tabs'),
            height: 46,
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: colors.separator)),
            ),
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
              itemCount: chips.length,
              separatorBuilder: (_, _) => const SizedBox(width: 6),
              itemBuilder: (_, index) => chips[index],
            ),
          ),
      ],
    );
  }
}

// 앱 막대 아이콘 버튼 44x44, 반경 12
class _HeaderButton extends StatelessWidget {
  const _HeaderButton({
    required this.icon,
    required this.tooltip,
    required this.onPressed,
    this.badge = false,
    super.key,
  });

  final String icon;
  final String tooltip;
  final VoidCallback? onPressed;
  final bool badge;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Semantics(
      button: true,
      label: tooltip,
      child: Tooltip(
        message: tooltip,
        child: SizedBox.square(
          dimension: 44,
          child: Stack(
            children: [
              Positioned.fill(
                child: TextButton(
                  onPressed: onPressed,
                  style: ButtonStyle(
                    padding: const WidgetStatePropertyAll(EdgeInsets.zero),
                    overlayColor: WidgetStatePropertyAll(colors.level2),
                    foregroundColor: WidgetStatePropertyAll(colors.foreground2),
                    shape: WidgetStatePropertyAll(
                      RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                  ),
                  child: IrisIcon(icon, size: 22),
                ),
              ),
              if (badge)
                Positioned(
                  top: 8,
                  right: 8,
                  child: Container(
                    key: const Key('session-github-failed'),
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: colors.blocked,
                      shape: BoxShape.circle,
                      border: Border.all(color: colors.background, width: 1.5),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
