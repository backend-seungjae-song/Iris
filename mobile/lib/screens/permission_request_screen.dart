import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:iris_remote/design/agent_tile.dart';
import 'package:iris_remote/design/command_text.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/markdown_text.dart';
import 'package:iris_remote/design/sheet.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/format/control_characters.dart';
import 'package:iris_remote/format/result_text.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/state/remote_state.dart';

Future<bool> showPermissionRequestSheet({
  required BuildContext context,
  required RemoteRequest request,
  required RemoteState state,
  required String agentName,
  required String agentKind,
  required String space,
}) async {
  final denied = await showIrisSheet<bool>(
    context: context,
    builder: (_) => PermissionRequestSheet(
      request: request,
      agentName: agentName,
      agentKind: agentKind,
      space: space,
      onAnswer: (allow) => state.answerPermission(request, allow: allow),
    ),
  );
  return denied ?? false;
}

class PermissionRequestSheet extends StatefulWidget {
  const PermissionRequestSheet({
    required this.request,
    required this.agentName,
    required this.agentKind,
    required this.space,
    required this.onAnswer,
    super.key,
  });

  final RemoteRequest request;
  final String agentName;
  final String agentKind;
  final String space;
  final Future<RequestAnswerResult> Function(bool allow) onAnswer;

  @override
  State<PermissionRequestSheet> createState() => _PermissionRequestSheetState();
}

class _PermissionRequestSheetState extends State<PermissionRequestSheet> {
  bool _busy = false;
  String? _result;

  PermissionRequestBody get _body =>
      widget.request.body as PermissionRequestBody;

  Future<void> _answer(bool allow) async {
    if (_busy || _result != null) return;
    setState(() => _busy = true);
    try {
      final result = await widget.onAnswer(allow);
      if (!mounted) return;
      final text = requestAnswerResultText(result.result);
      setState(() => _result = text);
      if (result.result == 'delivered' ||
          result.result == 'already-answered' ||
          result.result == 'expired') {
        Navigator.of(context).pop(!allow && result.result == 'delivered');
      }
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _result = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const IrisSheetGrabber(barKey: Key('permission-grabber')),
        const SizedBox(height: 14),
        SizedBox(
          key: const Key('permission-header'),
          height: 34,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Row(
              children: [
                IrisAgentTile(
                  key: const Key('permission-tile'),
                  kind: widget.agentKind,
                  status: 'blocked',
                  small: true,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        widget.agentName,
                        style: TextStyle(
                          color: context.iris.foreground2,
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          height: 17 / 14,
                        ),
                      ),
                      Text(
                        '${widget.space} · 방금',
                        style: TextStyle(
                          color: context.iris.muted,
                          fontSize: 13,
                          height: 16 / 13,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        SizedBox(
          key: const Key('permission-title'),
          height: 42.35,
          width: double.infinity,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(4, 14, 4, 0),
            child: Text(
              '명령 실행을 허용할까요?',
              style: TextStyle(
                color: context.iris.foreground,
                fontSize: 21,
                fontWeight: FontWeight.w700,
                height: 1.35,
                letterSpacing: -0.42,
              ),
            ),
          ),
        ),
        if (_body.description.isNotEmpty) ...[
          const SizedBox(height: 10),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 140),
            child: SingleChildScrollView(
              child: Align(
                alignment: Alignment.centerLeft,
                child: IrisMarkdown(
                  _body.description,
                  key: const Key('permission-description'),
                  compact: true,
                  baseStyle: TextStyle(
                    color: context.iris.foreground2,
                    fontSize: 14.5,
                    height: 1.45,
                  ),
                  textColor: context.iris.foreground2,
                ),
              ),
            ),
          ),
        ],
        const SizedBox(height: 14),
        _CommandBlock(
          key: const Key('permission-command'),
          command: visibleControlCharacters(_body.input),
        ),
        const SizedBox(height: 14),
        ClipRRect(
          key: const Key('permission-options'),
          borderRadius: BorderRadius.circular(20),
          child: Column(
            children: [
              _PermissionOption(
                key: const Key('permission-option-1'),
                index: 1,
                label: _busy ? '보내는 중…' : '허용',
                foreground: context.iris.brand,
                weight: FontWeight.w600,
                onPressed: _busy ? null : () => _answer(true),
              ),
              _PermissionOption(
                key: const Key('permission-option-2'),
                index: 2,
                label: '거절하고 다시 지시',
                foreground: context.iris.blocked,
                onPressed: _busy ? null : () => _answer(false),
              ),
            ],
          ),
        ),
        if (_result != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(_result!, style: TextStyle(color: context.iris.muted)),
          ),
      ],
    );
  }
}

class _CommandBlock extends StatelessWidget {
  const _CommandBlock({required this.command, super.key});

  final String command;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 66,
      width: double.infinity,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: context.iris.background,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Stack(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 44, 12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    r'$',
                    style: IrisType.mono.copyWith(color: context.iris.faint),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: IrisCommandText(
                      command: command,
                      style: IrisType.mono.copyWith(
                        color: context.iris.foreground2,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Positioned(
              right: 6,
              top: 6,
              child: SizedBox.square(
                dimension: 32,
                child: TextButton(
                  onPressed: () =>
                      Clipboard.setData(ClipboardData(text: command)),
                  style: const ButtonStyle(
                    padding: WidgetStatePropertyAll(EdgeInsets.zero),
                    overlayColor: WidgetStatePropertyAll(Colors.transparent),
                  ),
                  child: IrisIcon('copy', size: 16, color: context.iris.muted),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PermissionOption extends StatelessWidget {
  const _PermissionOption({
    required this.index,
    required this.label,
    required this.onPressed,
    this.foreground,
    this.weight = FontWeight.w400,
    super.key,
  }) : trailing = null;

  final int index;
  final String label;
  final VoidCallback? onPressed;
  final Color? foreground;
  final FontWeight weight;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 56,
      width: double.infinity,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: context.iris.level2,
          border: index == 1
              ? null
              : Border(top: BorderSide(color: context.iris.separator)),
        ),
        child: TextButton(
          onPressed: onPressed,
          style: const ButtonStyle(
            padding: WidgetStatePropertyAll(
              EdgeInsets.symmetric(horizontal: 18),
            ),
            overlayColor: WidgetStatePropertyAll(Colors.transparent),
            shape: WidgetStatePropertyAll(RoundedRectangleBorder()),
          ),
          child: Row(
            children: [
              Container(
                width: 24,
                height: 24,
                decoration: BoxDecoration(
                  color: context.iris.level3,
                  borderRadius: BorderRadius.circular(7),
                ),
                alignment: Alignment.center,
                child: Text(
                  '$index',
                  style: TextStyle(
                    color: context.iris.muted,
                    fontFamily: 'monospace',
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Text(
                  label,
                  style: TextStyle(
                    color: foreground ?? context.iris.foreground,
                    fontSize: 17,
                    fontWeight: weight,
                    height: 20 / 17,
                    letterSpacing: -0.17,
                  ),
                ),
              ),
              ?trailing,
            ],
          ),
        ),
      ),
    );
  }
}
