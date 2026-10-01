import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

class IrisIcon extends StatelessWidget {
  const IrisIcon(this.name, {this.size = 20, this.color, super.key});

  final String name;
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final resolved = color ?? IconTheme.of(context).color;
    return SvgPicture.asset(
      'assets/icons/$name.svg',
      width: size,
      height: size,
      colorFilter: resolved == null
          ? null
          : ColorFilter.mode(resolved, BlendMode.srcIn),
    );
  }
}
