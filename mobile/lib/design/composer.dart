import 'package:flutter/material.dart';
import 'package:iris_remote/design/agent_tile.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/pasted_context.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/state/remote_state.dart';

class IrisComposer extends StatefulWidget {
  const IrisComposer({
    required this.controller,
    required this.drafts,
    required this.sending,
    required this.stopping,
    required this.working,
    required this.workingLabel,
    required this.onSend,
    this.onRemoveDraft,
    this.onStop,
    this.modelLabel,
    this.autofocus = false,
    this.onTap,
    this.includeBottomInset = true,
    this.composerKey = const Key('session-composer'),
    this.inputBoxKey = const Key('session-input-box'),
    this.inputKey = const Key('session-input'),
    this.actionKey = const Key('session-action'),
    super.key,
  });

  final TextEditingController controller;
  final List<ComposerDraft> drafts;
  final bool sending;
  final bool stopping;
  final bool working;
  final String workingLabel;
  final VoidCallback onSend;
  final ValueChanged<String>? onRemoveDraft;
  final VoidCallback? onStop;
  final String? modelLabel;
  final bool autofocus;
  final VoidCallback? onTap;
  final bool includeBottomInset;
  final Key composerKey;
  final Key inputBoxKey;
  final Key inputKey;
  final Key actionKey;

  @override
  State<IrisComposer> createState() => _IrisComposerState();
}

class _IrisComposerState extends State<IrisComposer> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_changed);
  }

  @override
  void didUpdateWidget(covariant IrisComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_changed);
      widget.controller.addListener(_changed);
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_changed);
    super.dispose();
  }

  void _changed() => setState(() {});

  @override
  Widget build(BuildContext context) {
    final hasText =
        widget.controller.text.isNotEmpty || widget.drafts.isNotEmpty;
    final canStop = widget.onStop != null;
    return Container(
      key: widget.composerKey,
      padding: EdgeInsets.fromLTRB(
        12,
        10,
        12,
        widget.includeBottomInset ? irisBottomInset(context) : 8,
      ),
      color: context.iris.background,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (widget.working)
            SizedBox(
              height: 27,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(8, 0, 8, 10),
                child: Row(
                  children: [
                    const IrisStatusDot(status: 'working', size: 9),
                    const SizedBox(width: 7),
                    Text(
                      widget.workingLabel,
                      style: TextStyle(
                        color: context.iris.muted,
                        fontSize: 13.5,
                      ),
                    ),
                    if (widget.modelLabel != null) ...[
                      const Spacer(),
                      Text(
                        widget.modelLabel!,
                        style: TextStyle(
                          color: context.iris.muted,
                          fontSize: 13.5,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: Container(
                  key: widget.inputBoxKey,
                  padding: EdgeInsets.fromLTRB(
                    8,
                    widget.drafts.isEmpty ? 0 : 8,
                    8,
                    0,
                  ),
                  decoration: BoxDecoration(
                    color: context.iris.level1,
                    borderRadius: BorderRadius.circular(24),
                    border: Border.all(color: context.iris.separator),
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (widget.drafts.isNotEmpty)
                        Wrap(
                          key: const Key('composer-pasted-contexts'),
                          spacing: 7,
                          runSpacing: 7,
                          children: [
                            for (final draft in widget.drafts)
                              PastedContextChip(
                                key: Key('composer-draft-${draft.ref}'),
                                kind: pastedContextKind(draft.kind),
                                summary: draft.summary,
                                onPressed: () => showPastedContext(
                                  context: context,
                                  kind: pastedContextKind(draft.kind),
                                  summary: draft.summary,
                                  content: draft.content,
                                ),
                                onRemove: widget.onRemoveDraft == null
                                    ? null
                                    : () => widget.onRemoveDraft!(draft.ref),
                              ),
                          ],
                        ),
                      TextField(
                        key: widget.inputKey,
                        controller: widget.controller,
                        autofocus: widget.autofocus,
                        minLines: 1,
                        maxLines: 5,
                        maxLength: 4000,
                        enabled: !widget.sending,
                        onTap: widget.onTap,
                        style: TextStyle(
                          color: context.iris.foreground,
                          fontSize: 17,
                          height: 22 / 17,
                          letterSpacing: -0.17,
                        ),
                        decoration: InputDecoration(
                          hintText: '메시지 보내기',
                          hintStyle: TextStyle(
                            color: context.iris.faint,
                            fontSize: 17,
                            height: 1.2,
                            letterSpacing: -0.17,
                          ),
                          counterText: '',
                          isDense: true,
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 13,
                          ),
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          filled: false,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 8),
              IrisRoundButton(
                key: widget.actionKey,
                icon: hasText || !canStop ? 'arrow-up' : 'stop-fill',
                size: 48,
                backgroundColor: hasText
                    ? context.iris.brand
                    : context.iris.level2,
                foregroundColor: hasText
                    ? context.iris.onBrand
                    : context.iris.foreground,
                tooltip: hasText || !canStop ? '보내기' : '중지',
                onPressed: widget.sending || widget.stopping
                    ? null
                    : (hasText ? widget.onSend : widget.onStop),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
