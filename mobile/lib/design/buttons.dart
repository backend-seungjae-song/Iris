import 'package:flutter/material.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/tokens.dart';

enum IrisButtonTone { primary, secondary, danger, ghost }

// 알약 버튼 .btn. 높이 48 기본, 36은 .btn.sm
class IrisButton extends StatelessWidget {
  const IrisButton({
    required this.label,
    required this.onPressed,
    this.tone = IrisButtonTone.secondary,
    this.icon,
    this.height = 48,
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

  // Row 안에서 Expanded 로 감싸지 않은 본체. IrisActionBar 가 사용
  Widget body(BuildContext context) {
    final colors = context.iris;
    final small = height == 36;
    final off = onPressed == null;
    final (background, foreground, ring) = switch (tone) {
      IrisButtonTone.primary when off => (
        colors.level2,
        colors.muted,
        colors.separator,
      ),
      IrisButtonTone.primary => (
        colors.brand,
        colors.onBrand,
        colors.accentEdge,
      ),
      IrisButtonTone.secondary => (
        colors.level2,
        colors.foreground,
        colors.separator,
      ),
      IrisButtonTone.danger => (
        colors.dangerTint,
        colors.dangerText,
        Colors.transparent,
      ),
      IrisButtonTone.ghost => (
        Colors.transparent,
        colors.foreground2,
        Colors.transparent,
      ),
    };
    final fontSize = small ? 13.5 : 15.0;
    final textTheme = Theme.of(context).textTheme.labelLarge;
    final button = SizedBox(
      width: width,
      height: height,
      child: TextButton(
        onPressed: onPressed,
        style: ButtonStyle(
          overlayColor: WidgetStateProperty.resolveWith(
            (states) =>
                tone == IrisButtonTone.ghost &&
                    states.contains(WidgetState.pressed)
                ? colors.tint
                : Colors.transparent,
          ),
          minimumSize: const WidgetStatePropertyAll(Size.zero),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          padding: WidgetStatePropertyAll(
            EdgeInsets.symmetric(horizontal: small ? 14 : 20),
          ),
          backgroundColor: WidgetStatePropertyAll(background),
          foregroundColor: WidgetStatePropertyAll(foreground),
          shape: WidgetStatePropertyAll(
            RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(IrisRadius.pill),
              side: BorderSide(
                color: ring,
                strokeAlign: BorderSide.strokeAlignInside,
              ),
            ),
          ),
          textStyle: WidgetStatePropertyAll(
            TextStyle(
              fontFamily: textTheme?.fontFamily,
              fontFamilyFallback: textTheme?.fontFamilyFallback,
              fontSize: fontSize,
              fontWeight: FontWeight.w600,
              height: 1.2,
              letterSpacing: fontSize * -0.005,
            ),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (icon != null) ...[
              IrisIcon(icon!, size: small ? 15 : 18),
              const SizedBox(width: 8),
            ],
            Flexible(
              child: Text(label, maxLines: 1, overflow: TextOverflow.clip),
            ),
          ],
        ),
      ),
    );
    // 비활성 .btn[disabled] 불투명도 .42. 주색은 면 색으로 표현해 1
    return off && tone != IrisButtonTone.primary
        ? Opacity(opacity: .42, child: button)
        : button;
  }

  @override
  Widget build(BuildContext context) {
    final button = body(context);
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
