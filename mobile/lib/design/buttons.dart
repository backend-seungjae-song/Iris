import 'package:flutter/material.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/tokens.dart';

enum IrisButtonTone { primary, secondary, danger, ghost }

class IrisButton extends StatelessWidget {
  const IrisButton({
    required this.label,
    required this.onPressed,
    this.tone = IrisButtonTone.secondary,
    this.icon,
    this.height = 50,
    this.width,
    this.expand = true,
    super.key,
  });

  final String label;
  final VoidCallback? onPressed;
  final IrisButtonTone tone;
  final String? icon;
  final double height;
  final double? width;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final (background, foreground) = switch (tone) {
      IrisButtonTone.primary => (colors.brand, colors.onBrand),
      IrisButtonTone.secondary => (colors.level2, colors.foreground),
      IrisButtonTone.danger => (colors.level2, colors.blocked),
      IrisButtonTone.ghost => (Colors.transparent, colors.link),
    };
    final button = SizedBox(
      width: width,
      height: height,
      child: TextButton(
        onPressed: onPressed,
        style: ButtonStyle(
          overlayColor: const WidgetStatePropertyAll(Colors.transparent),
          minimumSize: const WidgetStatePropertyAll(Size.zero),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          padding: WidgetStatePropertyAll(
            EdgeInsets.symmetric(
              horizontal: tone == IrisButtonTone.ghost ? 6 : 14,
            ),
          ),
          backgroundColor: WidgetStatePropertyAll(background),
          foregroundColor: WidgetStatePropertyAll(foreground),
          shape: WidgetStatePropertyAll(
            RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(height == 36 ? 11 : 14),
            ),
          ),
          textStyle: WidgetStatePropertyAll(
            TextStyle(
              fontFamily: Theme.of(context).textTheme.labelLarge?.fontFamily,
              fontFamilyFallback: Theme.of(context)
                  .textTheme
                  .labelLarge
                  ?.fontFamilyFallback,
              fontSize: height == 36 ? 15 : 17,
              fontWeight: tone == IrisButtonTone.ghost
                  ? FontWeight.w500
                  : FontWeight.w600,
              height: 1.2,
              letterSpacing: height == 36 ? 0 : -0.17,
            ),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (icon != null) ...[
              IrisIcon(icon!, size: height == 36 ? 15 : 18),
              const SizedBox(width: 7),
            ],
            Text(label),
          ],
        ),
      ),
    );
    return expand ? Expanded(child: button) : button;
  }
}

class IrisRoundButton extends StatelessWidget {
  const IrisRoundButton({
    required this.icon,
    required this.onPressed,
    this.size = 40,
    this.backgroundColor,
    this.foregroundColor,
    this.tooltip,
    super.key,
  });

  final String icon;
  final VoidCallback? onPressed;
  final double size;
  final Color? backgroundColor;
  final Color? foregroundColor;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final button = Semantics(
      button: true,
      label: tooltip,
      child: SizedBox.square(
        dimension: size,
        child: TextButton(
          onPressed: onPressed,
          style: ButtonStyle(
            padding: const WidgetStatePropertyAll(EdgeInsets.zero),
            overlayColor: const WidgetStatePropertyAll(Colors.transparent),
            backgroundColor: WidgetStatePropertyAll(
              backgroundColor ?? context.iris.level1,
            ),
            foregroundColor: WidgetStatePropertyAll(
              foregroundColor ?? context.iris.foreground2,
            ),
            shape: WidgetStatePropertyAll(
              RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(size / 2),
              ),
            ),
          ),
          child: IrisIcon(icon, size: size == 40 ? 20 : 18),
        ),
      ),
    );
    return tooltip == null ? button : Tooltip(message: tooltip!, child: button);
  }
}
