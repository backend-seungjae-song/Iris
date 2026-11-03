import 'dart:async';

import 'package:flutter/material.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/card.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/markdown_text.dart';
import 'package:iris_remote/design/select_mark.dart';
import 'package:iris_remote/design/toast.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/format/question_text.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/response_kit.dart';
import 'package:iris_remote/screens/review_answers.dart';

class TerminalQuestionCard extends StatefulWidget {
  const TerminalQuestionCard({
    required this.request,
    required this.agentName,
    required this.onOpen,
    this.session,
    this.onChat,
    this.onAnswer,
    super.key,
  });

  final ActiveRemoteSession? session;
  final RemoteRequest request;
  final String agentName;
  final VoidCallback onOpen;
  // 대화로 이어가는 선택지를 보낸 뒤 그 세션의 대화창을 여는 동작
  final VoidCallback? onChat;
  // 전체 화면 질문 열기. 없으면 카드만 보여줌(터미널 화면 안)
  final VoidCallback? onAnswer;

  // 전체 화면 질문이 같은 문구를 쓰도록 공개
  static String variantLabel(PromptVariant variant) =>
      _TerminalQuestionCardState.variantLabel(variant);
  static String variantIcon(PromptVariant variant) =>
      _TerminalQuestionCardState.variantIcon(variant);
  static String optionText(String text) =>
      _TerminalQuestionCardState.optionText(text);

  @override
  State<TerminalQuestionCard> createState() => _TerminalQuestionCardState();
}

class _TerminalQuestionCardState extends State<TerminalQuestionCard> {
  bool _sending = false;
  // 체크 전환을 보낸 줄과 그때 화면. 화면이 바뀌어 새 체크 상태가 올 때까지 로딩 표시
  int? _pendingRow;
  String? _pendingHash;
  Timer? _pendingTimer;
  @override
  void dispose() {
    _pendingTimer?.cancel();
    super.dispose();
  }

  Future<void> _select(TerminalPromptOption option) async {
    if (_sending || !option.selectable || widget.session == null) return;
    final screen = (widget.request.body as QuestionRequestBody).screen!;
    setState(() {
      _sending = true;
      if (option.checked != null) {
        _pendingRow = option.row;
        _pendingHash = screen.hash;
        _pendingTimer?.cancel();
        _pendingTimer = Timer(const Duration(seconds: 5), () {
          if (mounted) setState(() => _pendingRow = null);
        });
      }
    });
    try {
      await widget.session!.watchTerminal(widget.request.agent);
      await widget.session!.selectTerminal(
        widget.request.agent,
        screen.hash,
        screen.columns,
        screen.rows,
        option.row,
      );
      if (option.role == PromptRole.chat) widget.onChat?.call();
    } on RemoteFailure catch (error) {
      if (mounted) {
        showIrisToast(
          context,
          error.message.contains('화면이 바뀌')
              ? '화면이 바뀌었습니다. 새로 고침하세요.'
              : error.message,
          tone: IrisToastTone.error,
        );
      }
    } catch (_) {
      if (mounted) {
        showIrisToast(context, '컴퓨터와 연결이 끊겼습니다.', tone: IrisToastTone.error);
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  static String variantLabel(PromptVariant variant) => switch (variant) {
    PromptVariant.command => '명령 실행 허용',
    PromptVariant.edit => '파일 수정 허용',
    PromptVariant.network => '네트워크 접근 허용',
    PromptVariant.permissions => '권한 요청',
    PromptVariant.tool => '도구 사용 허용',
    PromptVariant.plan => '계획 확인',
    PromptVariant.trust => '폴더 신뢰 확인',
    PromptVariant.review => '답변 확인 후 제출',
    PromptVariant.approval => '승인 요청',
    PromptVariant.choice => '선택 질문',
  };

  static String variantIcon(PromptVariant variant) => switch (variant) {
    PromptVariant.command => 'terminal-window',
    PromptVariant.edit || PromptVariant.plan => 'file-text',
    PromptVariant.network => 'globe',
    PromptVariant.permissions || PromptVariant.trust => 'lock-simple',
    PromptVariant.tool ||
    PromptVariant.approval ||
    PromptVariant.review => 'check-circle',
    PromptVariant.choice => 'chat-circle-dots',
  };

  // 선택지 앞의 번호·표시·단축키 제거
  static String optionText(String text) => text
      .replaceFirst(RegExp(r'^\s*(?:[›❯●○]\s*)?(?:\d+[.)]\s*)?'), '')
      .trim();

  Widget _option(
    BuildContext context,
    TerminalPromptOption option,
    bool actionable,
  ) {
    final enabled = !_sending;
    final VoidCallback? action = option.selectable
        ? (enabled ? () => _select(option) : null)
        : widget.onOpen;
    final view = formatOption(option.text, description: option.description);
    final label = view.label;
    final colors = context.iris;
    final (background, foreground, hint) = switch (option.role) {
      PromptRole.allow => (colors.brand, colors.onBrand, null),
      PromptRole.allowAlways => (colors.level1, colors.foreground, null),
      PromptRole.deny => (colors.level1, colors.dangerText, null),
      PromptRole.text => (Colors.transparent, colors.link, '터미널에서 입력'),
      PromptRole.choice => (colors.level1, colors.foreground, null),
      PromptRole.chat => (colors.level1, colors.link, null),
    };
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Material(
        color: background,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: option.role == PromptRole.allow
              ? BorderSide.none
              : BorderSide(color: colors.line2),
        ),
        child: InkWell(
          key: Key('terminal-option-${option.row}'),
          borderRadius: BorderRadius.circular(12),
          onTap: actionable ? action : widget.onOpen,
          child: Container(
            width: double.infinity,
            constraints: const BoxConstraints(minHeight: 50),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            alignment: Alignment.center,
            child: Row(
              children: [
                if (option.checked != null) ...[
                  IrisSelectMark(
                    selected: option.checked!,
                    square: true,
                    loading:
                        _pendingRow == option.row &&
                        _pendingHash ==
                            (widget.request.body as QuestionRequestBody)
                                .screen
                                ?.hash,
                  ),
                  const SizedBox(width: 12),
                ],
                Expanded(
                  child: Column(
                    crossAxisAlignment: option.checked != null
                        ? CrossAxisAlignment.start
                        : CrossAxisAlignment.center,
                    children: [
                      Text.rich(
                        TextSpan(
                          children: [
                            TextSpan(
                              text: hint == null ? label : '$label · $hint',
                            ),
                            if (view.recommended) ...[
                              const TextSpan(text: '  '),
                              const WidgetSpan(
                                alignment: PlaceholderAlignment.middle,
                                child: ResponseBadge('추천'),
                              ),
                            ],
                            if (view.previous) ...[
                              const TextSpan(text: '  '),
                              const WidgetSpan(
                                alignment: PlaceholderAlignment.middle,
                                child: ResponseBadge('이전 선택', muted: true),
                              ),
                            ],
                          ],
                        ),
                        textAlign: option.checked != null
                            ? TextAlign.left
                            : TextAlign.center,
                        style: TextStyle(
                          color: foreground,
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                          height: 1.25,
                        ),
                      ),
                      if (view.description.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Text(
                            view.description,
                            textAlign: option.checked != null
                                ? TextAlign.left
                                : TextAlign.center,
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                            style: IrisType.meta.copyWith(color: colors.muted),
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _reviewContent(String detail, List<ReviewAnswer> answers) {
    final warning = reviewWarning(detail);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (answers.isNotEmpty) ReviewAnswersList(answers: answers),
        if (warning != null)
          Padding(
            padding: EdgeInsets.only(top: answers.isEmpty ? 0 : 12),
            child: Text(
              warning,
              style: IrisType.meta.copyWith(color: context.iris.pink),
            ),
          ),
        if (answers.isEmpty && warning == null)
          Text(detail, style: IrisType.meta),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final request = widget.request;
    final body = request.body as QuestionRequestBody;
    final screen = body.screen;
    final colors = context.iris;
    final variant = screen?.variant ?? PromptVariant.choice;
    final title = screen == null
        ? ''
        : (screen.title.isNotEmpty
              ? screen.title
              : (body.questions.isEmpty ? '' : body.questions.first.question));
    final question = screen != null && screen.tool.isNotEmpty
        ? toolApprovalText(screen.tool, screen.target)
        : formatQuestion(
            variant == PromptVariant.review ? '이대로 제출할까요?' : title,
          );
    // 선택지·제출 버튼이 카드 안에 있으면 전체 화면 진입 버튼이 중복, 머리줄을 눌러 전체 화면으로 감
    final inlineAnswerable =
        widget.session != null && screen != null && screen.options.isNotEmpty;
    final reviewAnswers = variant == PromptVariant.review && screen != null
        ? parseReviewAnswers(screen.detail)
        : const <ReviewAnswer>[];
    return IrisCard(
      key: Key('terminal-question-${request.ref}'),
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            InkWell(
              onTap: widget.onAnswer ?? widget.onOpen,
              child: Row(
                children: [
                  Container(
                    width: 30,
                    height: 30,
                    decoration: BoxDecoration(
                      color: colors.pink,
                      borderRadius: BorderRadius.circular(9),
                    ),
                    child: Center(
                      child: IrisIcon(
                        variantIcon(variant),
                        size: 17,
                        color: colors.ink,
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      '${widget.agentName} · ${variantLabel(variant)}${screen != null && screen.steps > 1 ? ' · 질문 ${screen.step}/${screen.steps}' : (body.questions.length > 1 ? ' · 질문 ${body.questions.length}개' : '')}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: IrisType.rowTitle,
                    ),
                  ),
                ],
              ),
            ),
            if (screen == null)
              for (final question in body.questions) ...[
                const SizedBox(height: 10),
                IrisMarkdown(question.question),
                for (final option in question.options)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: IrisMarkdown(
                      '${option.label}${option.description.isEmpty ? '' : '\n${option.description}'}',
                    ),
                  ),
              ]
            else ...[
              const SizedBox(height: 10),
              Text(question.title, style: IrisType.body),
              if (question.body.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    question.body,
                    key: const Key('terminal-question-body'),
                    style: IrisType.meta.copyWith(color: colors.muted),
                  ),
                ),
              if (screen.detail.isNotEmpty) ...[
                const SizedBox(height: 10),
                Container(
                  key: const Key('terminal-prompt-detail'),
                  width: double.infinity,
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: colors.level2,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: variant == PromptVariant.review
                      ? _reviewContent(screen.detail, reviewAnswers)
                      : variant == PromptVariant.plan
                      ? ConstrainedBox(
                          constraints: const BoxConstraints(maxHeight: 220),
                          child: SingleChildScrollView(
                            physics: const NeverScrollableScrollPhysics(),
                            child: IrisMarkdown(
                              joinWrappedLines(screen.detail),
                            ),
                          ),
                        )
                      : Text(
                          screen.detail,
                          maxLines: 10,
                          overflow: TextOverflow.ellipsis,
                          style: IrisType.mono.copyWith(
                            color: colors.foreground,
                          ),
                        ),
                ),
              ],
              // 선택지 줄에 설명이 없을 때만 질문 본문의 설명을 따로 보임
              for (final question in body.questions)
                for (final option in question.options)
                  if (option.description.isNotEmpty &&
                      !screen.options.any(
                        (o) =>
                            o.description.isNotEmpty &&
                            formatOption(o.text).label ==
                                formatOption(option.label).label,
                      ))
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: IrisMarkdown(
                        '${formatOption(option.label).label}: ${joinParagraph(option.description)}',
                      ),
                    ),
              const SizedBox(height: 6),
              for (final option in screen.options)
                _option(context, option, widget.session != null),
            ],
            const SizedBox(height: 10),
            if (widget.onAnswer != null && !inlineAnswerable)
              IrisButton(
                key: Key('terminal-question-answer-${request.ref}'),
                label: '답하기',
                tone: IrisButtonTone.primary,
                expand: false,
                width: double.infinity,
                onPressed: widget.onAnswer,
              ),
            if (widget.onAnswer != null && !inlineAnswerable)
              const SizedBox(height: 6),
            IrisButton(
              key: Key('terminal-question-open-${request.ref}'),
              label: '터미널에서 답하기',
              tone: IrisButtonTone.ghost,
              height: 36,
              expand: false,
              onPressed: widget.onOpen,
            ),
          ],
        ),
      ),
    );
  }
}
