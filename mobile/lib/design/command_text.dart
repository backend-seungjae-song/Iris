import 'package:flutter/material.dart';

class IrisCommandText extends StatelessWidget {
  const IrisCommandText({
    required this.command,
    required this.style,
    super.key,
  });

  final String command;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    final slash = command.lastIndexOf('/');
    if (slash < 0 || slash == command.length - 1) {
      return Text(
        command,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: style,
      );
    }
    return Text.rich(
      TextSpan(
        style: style,
        children: [
          TextSpan(text: command.substring(0, slash + 1)),
          WidgetSpan(
            alignment: PlaceholderAlignment.baseline,
            baseline: TextBaseline.alphabetic,
            child: Text(
              command.substring(slash + 1),
              maxLines: 1,
              softWrap: false,
              overflow: TextOverflow.ellipsis,
              style: style,
            ),
          ),
        ],
      ),
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
    );
  }
}
