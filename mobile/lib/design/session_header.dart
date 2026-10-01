import 'package:flutter/material.dart';
import 'package:iris_remote/design/agent_tile.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/logo.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/protocol.dart';

enum SessionMode { chat, terminal, browser }

class IrisSessionHeader extends StatelessWidget {
  const IrisSessionHeader({
    required this.title,
    required this.subtitle,
    required this.mode,
    required this.tabs,
    required this.onBack,
    this.agentKind,
    this.canTerminal = false,
    this.canChat = true,
    this.canBrowser = false,
    this.onChat,
    this.onTerminal,
    this.onBrowser,
    this.onGitHub,
    this.githubFailed = false,
    super.key,
  });

  final String title;
  final String subtitle;
  final String? agentKind;
  final SessionMode mode;
  final List<Widget> tabs;
  final VoidCallback onBack;
  final bool canTerminal;
  final bool canChat;
  final bool canBrowser;
  final VoidCallback? onChat;
  final VoidCallback? onTerminal;
  final VoidCallback? onBrowser;
  final VoidCallback? onGitHub;
  final bool githubFailed;

  @override
  Widget build(BuildContext context) {
    final hasModes = canTerminal || canBrowser;
    return SizedBox(
      key: const Key('session-header'),
      height: 98,
      child: Column(
        children: [
          SizedBox(
            height: 48,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                children: [
                  IrisRoundButton(
                    key: const Key('session-back'),
                    icon: 'caret-left',
                    tooltip: '뒤로',
                    onPressed: onBack,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 17,
                            fontWeight: FontWeight.w600,
                            height: 20 / 17,
                            letterSpacing: -0.17,
                          ),
                        ),
                        const SizedBox(height: 1),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            if (agentKind != null) ...[
                              IconTheme(
                                data: IconThemeData(color: context.iris.muted),
                                child: IrisAgentLogo(
                                  kind: agentKind!,
                                  size: 13,
                                ),
                              ),
                              const SizedBox(width: 6),
                            ] else ...[
                              IrisIcon(
                                'globe',
                                size: 13,
                                color: context.iris.muted,
                              ),
                              const SizedBox(width: 6),
                            ],
                            Flexible(
                              child: Text(
                                subtitle,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  color: context.iris.muted,
                                  fontSize: 13,
                                  height: 16 / 13,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  if (hasModes)
                    Container(
                      key: const Key('session-mode'),
                      height: 36,
                      padding: const EdgeInsets.all(3),
                      decoration: BoxDecoration(
                        color: context.iris.level1,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (canChat)
                            _ModeButton(
                              label: '대화',
                              selected: mode == SessionMode.chat,
                              onPressed: onChat,
                            ),
                          if (canTerminal)
                            _ModeButton(
                              label: '터미널',
                              selected: mode == SessionMode.terminal,
                              onPressed: onTerminal,
                            ),
                          if (canBrowser)
                            _ModeButton(
                              key: const Key('session-browser'),
                              icon: 'globe',
                              selected: mode == SessionMode.browser,
                              onPressed: onBrowser,
                            ),
                        ],
                      ),
                    )
                  else
                    const SizedBox(width: 40),
                ],
              ),
            ),
          ),
          Container(
            key: const Key('session-tabs'),
            height: 50,
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: context.iris.separator)),
            ),
            child: Row(
              children: [
                if (mode != SessionMode.browser && onGitHub != null) ...[
                  const SizedBox(width: 12),
                  _GitButton(onPressed: onGitHub!, failed: githubFailed),
                  const SizedBox(width: 6),
                ],
                Expanded(
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    padding: EdgeInsets.fromLTRB(
                      mode == SessionMode.browser ? 12 : 0,
                      8,
                      12,
                      10,
                    ),
                    itemCount: tabs.length,
                    separatorBuilder: (_, _) => const SizedBox(width: 6),
                    itemBuilder: (_, index) => tabs[index],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ModeButton extends StatelessWidget {
  const _ModeButton({
    this.label,
    this.icon,
    required this.selected,
    this.onPressed,
    super.key,
  });

  final String? label;
  final String? icon;
  final bool selected;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 30,
      constraints: BoxConstraints(
        minWidth: icon == null ? (label == '터미널' ? 55 : 43.4) : 35,
      ),
      decoration: BoxDecoration(
        color: selected ? context.iris.level3 : Colors.transparent,
        borderRadius: BorderRadius.circular(9),
      ),
      child: TextButton(
        onPressed: onPressed,
        style: const ButtonStyle(
          padding: WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 9)),
          minimumSize: WidgetStatePropertyAll(Size.zero),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
        child: icon == null
            ? Text(
                label!,
                style: TextStyle(
                  color: selected
                      ? context.iris.foreground
                      : context.iris.muted,
                  fontSize: 13.5,
                  fontWeight: FontWeight.w500,
                  height: 1.2,
                ),
              )
            : IrisIcon(
                icon!,
                size: 17,
                color: selected ? context.iris.foreground : context.iris.muted,
              ),
      ),
    );
  }
}

class _GitButton extends StatelessWidget {
  const _GitButton({required this.onPressed, required this.failed});

  final VoidCallback onPressed;
  final bool failed;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      key: const Key('session-github'),
      width: 40,
      height: 32,
      child: Stack(
        children: [
          Positioned.fill(
            child: TextButton(
              onPressed: onPressed,
              style: ButtonStyle(
                padding: const WidgetStatePropertyAll(EdgeInsets.zero),
                backgroundColor: WidgetStatePropertyAll(context.iris.level1),
                shape: WidgetStatePropertyAll(
                  RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                  ),
                ),
              ),
              child: IrisIcon(
                'github-logo',
                size: 18,
                color: context.iris.foreground2,
              ),
            ),
          ),
          if (failed)
            Positioned(
              top: 2,
              right: 3,
              child: Container(
                key: const Key('session-github-failed'),
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                  color: context.iris.blocked,
                  borderRadius: BorderRadius.circular(4),
                  boxShadow: [
                    BoxShadow(color: context.iris.background, spreadRadius: 2),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class IrisAgentTab extends StatelessWidget {
  const IrisAgentTab({
    required this.agent,
    required this.selected,
    required this.onPressed,
    super.key,
  });

  final RemoteAgent agent;
  final bool selected;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => _TabChip(
    selected: selected,
    onPressed: onPressed,
    leading: IrisStatusDot(
      status: agent.question ? 'question' : agent.status,
      size: 9,
    ),
    label: agent.name,
  );
}

class IrisBrowserTab extends StatelessWidget {
  const IrisBrowserTab({
    required this.tab,
    required this.selected,
    required this.onPressed,
    super.key,
  });

  final BrowserTab tab;
  final bool selected;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => _TabChip(
    key: Key('session-browser-tab-${tab.ref}'),
    selected: selected,
    onPressed: onPressed,
    leading: IrisIcon(
      tab.url.contains('github.com') ? 'github-logo' : 'globe',
      size: 14,
      color: context.iris.muted,
    ),
    label: tab.title,
    trailing: tab.aiControlled ? const _AiDot() : null,
  );
}

class IrisShellTab extends StatelessWidget {
  const IrisShellTab({super.key});

  @override
  Widget build(BuildContext context) => _TabChip(
    selected: false,
    onPressed: null,
    leading: IrisIcon('terminal-window', size: 14, color: context.iris.muted),
    label: 'shell',
  );
}

class IrisNewBrowserTab extends StatelessWidget {
  const IrisNewBrowserTab({required this.onPressed, super.key});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => _TabChip(
    selected: false,
    onPressed: onPressed,
    leading: IrisIcon('plus', size: 14, color: context.iris.muted),
    label: '새 탭',
  );
}

class _TabChip extends StatelessWidget {
  const _TabChip({
    required this.selected,
    required this.onPressed,
    required this.leading,
    required this.label,
    this.trailing,
    super.key,
  });

  final bool selected;
  final VoidCallback? onPressed;
  final Widget leading;
  final String label;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 32,
      child: TextButton(
        onPressed: onPressed,
        style: ButtonStyle(
          padding: WidgetStatePropertyAll(
            EdgeInsets.fromLTRB(10, 0, selected ? 10 : 11, 0),
          ),
          backgroundColor: WidgetStatePropertyAll(
            selected ? context.iris.level3 : context.iris.level1,
          ),
          foregroundColor: WidgetStatePropertyAll(
            selected ? context.iris.foreground : context.iris.foreground2,
          ),
          shape: WidgetStatePropertyAll(
            RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(16),
              side: selected
                  ? BorderSide(color: context.iris.separator)
                  : BorderSide.none,
            ),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            leading,
            const SizedBox(width: 7),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 170),
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 13.5,
                  height: 16 / 13.5,
                  fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                ),
              ),
            ),
            if (trailing != null) ...[const SizedBox(width: 7), trailing!],
          ],
        ),
      ),
    );
  }
}

class _AiDot extends StatelessWidget {
  const _AiDot();

  @override
  Widget build(BuildContext context) => Container(
    width: 6,
    height: 6,
    decoration: BoxDecoration(
      color: const Color(0xfff4a1a7),
      borderRadius: BorderRadius.circular(3),
    ),
  );
}
