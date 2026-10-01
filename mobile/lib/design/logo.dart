import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:iris_remote/design/icon.dart';

class IrisAgentLogo extends StatelessWidget {
  const IrisAgentLogo({required this.kind, required this.size, super.key});

  final String kind;
  final double size;

  @override
  Widget build(BuildContext context) {
    if (kind == 'claude') {
      return SvgPicture.asset(
        'assets/logos/claude.svg',
        width: size,
        height: size,
      );
    }
    if (kind == 'codex') {
      return SvgPicture.asset(
        'assets/logos/codex.svg',
        width: size,
        height: size,
        colorFilter: ColorFilter.mode(
          IconTheme.of(context).color ??
              Theme.of(context).colorScheme.onSurface,
          BlendMode.srcIn,
        ),
      );
    }
    return IrisIcon(
      kind == 'terminal' ? 'terminal-window' : 'user',
      size: size,
    );
  }
}
