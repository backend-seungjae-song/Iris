import 'package:flutter/material.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/pasted_context.dart';
import 'package:iris_remote/design/status_glyph.dart';
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
    this.blockedLabel,
    this.hintText = '메시지 보내기',
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
  // 질문 대기 중 안내 줄 글. null 이면 줄을 그리지 않는다
  final String? blockedLabel;
  final String hintText;
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
    final colors = context.iris;
    final hasText =
        widget.controller.text.isNotEmpty || widget.drafts.isNotEmpty;
    final strip = widget.working || widget.blockedLabel != null;
    return Container(
      key: widget.composerKey,
      color: colors.background,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (strip)
            Container(
              constraints: const BoxConstraints(minHeight: 52),
              padding: const EdgeInsets.fromLTRB(16, 6, 8, 6),
              decoration: BoxDecoration(
                color: colors.background2,
                border: Border(top: BorderSide(color: colors.separator)),
              ),
              child: Row(
                children: [
                  IrisStatusGlyph(
                    status: widget.working ? 'working' : 'blocked',
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      widget.working
                          ? widget.workingLabel
                          : widget.blockedLabel!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: colors.foreground2,
                        fontSize: 13,
                        height: 1.4,
                      ),
                    ),
                  ),
                  if (widget.working && widget.modelLabel != null) ...[
                    Text(
                      widget.modelLabel!,
                      style: TextStyle(color: colors.muted, fontSize: 13),
                    ),
                    const SizedBox(width: 8),
                  ],
                  if (widget.working && widget.onStop != null)
                    _StopButton(
                      onPressed: widget.stopping ? null : widget.onStop,
                    ),
                ],
              ),
            ),
          Padding(
            padding: EdgeInsets.fromLTRB(
              12,
              8,
              12,
              widget.includeBottomInset ? irisBottomInset(context) : 10,
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: Container(
                    key: widget.inputBoxKey,
                    constraints: const BoxConstraints(minHeight: 48),
                    padding: EdgeInsets.fromLTRB(
                      8,
                      widget.drafts.isEmpty ? 4 : 10,
                      4,
                      4,
                    ),
                    decoration: BoxDecoration(
                      color: colors.level1,
                      borderRadius: BorderRadius.circular(22),
                      border: Border.all(color: colors.line2),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Expanded(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              if (widget.drafts.isNotEmpty)
                                Padding(
                                  padding: const EdgeInsets.only(
                                    left: 4,
                                    bottom: 4,
                                  ),
                                  // 첨부가 많아도 입력창이 화면을 채우지 않게 두 줄 반 높이에서 멈추고 안에서 스크롤
                                  child: ConstrainedBox(
                                    constraints: const BoxConstraints(
                                      maxHeight: 92,
                                    ),
                                    child: SingleChildScrollView(
                                      child: Wrap(
                                        key: const Key(
                                          'composer-pasted-contexts',
                                        ),
                                        spacing: 7,
                                        runSpacing: 7,
                                        children: [
                                          for (final draft in widget.drafts)
                                            PastedContextChip(
                                              key: Key(
                                                'composer-draft-${draft.ref}',
                                              ),
                                              kind: pastedContextKind(
                                                draft.kind,
                                              ),
                                              summary: draft.summary,
                                              onPressed: () =>
                                                  showPastedContext(
                                                    context: context,
                                                    kind: pastedContextKind(
                                                      draft.kind,
                                                    ),
                                                    summary: draft.summary,
                                                    content: draft.content,
                                                  ),
                                              onRemove:
                                                  widget.onRemoveDraft == null
                                                  ? null
                                                  : () => widget.onRemoveDraft!(
                                                      draft.ref,
                                                    ),
                                            ),
                                        ],
                                      ),
                                    ),
                                  ),
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
                                  color: colors.foreground,
                                  fontSize: 15,
                                  height: 22 / 15,
                                ),
                                decoration: InputDecoration(
                                  hintText: widget.hintText,
                                  hintStyle: TextStyle(
                                    color: colors.muted,
                                    fontSize: 15,
                                    height: 22 / 15,
                                  ),
                                  counterText: '',
                                  isDense: true,
                                  contentPadding: const EdgeInsets.symmetric(
                                    horizontal: 6,
                                    vertical: 9,
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
                        const SizedBox(width: 4),
                        IrisRoundButton(
                          key: widget.actionKey,
                          icon: 'arrow-up',
                          size: 40,
                          backgroundColor: hasText
                              ? colors.brand
                              : colors.level3,
                          foregroundColor: hasText
                              ? colors.onBrand
                              : colors.faint,
                          tooltip: '보내기',
                          onPressed: widget.sending || !hasText
                              ? null
                              : widget.onSend,
                        ),
                      ],
                    ),
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

// 작업 중 줄의 중지 버튼. 높이 40 + 위아래 4 터치 영역
class _StopButton extends StatelessWidget {
  const _StopButton({required this.onPressed});

  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Semantics(
      button: true,
      label: '중지',
      child: InkWell(
        key: const Key('session-stop'),
        onTap: onPressed,
        borderRadius: BorderRadius.circular(24),
        child: SizedBox(
          height: 48,
          child: Center(
            child: Container(
              height: 40,
              padding: const EdgeInsets.fromLTRB(12, 0, 14, 0),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: colors.pink, width: 1.5),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  IrisIcon('stop-fill', size: 16, color: colors.dangerText),
                  const SizedBox(width: 6),
                  Text(
                    '중지',
                    style: TextStyle(
                      color: colors.dangerText,
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
