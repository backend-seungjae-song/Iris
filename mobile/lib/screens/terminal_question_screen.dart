import 'dart:async';

import 'package:flutter/material.dart';
import 'package:iris_remote/design/action_bar.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/markdown_text.dart';
import 'package:iris_remote/design/motion.dart';
import 'package:iris_remote/design/toast.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/format/question_text.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/response_kit.dart';
import 'package:iris_remote/screens/review_answers.dart';
import 'package:iris_remote/screens/terminal_question_card.dart';
import 'package:iris_remote/state/remote_state.dart';

// 터미널 화면에서 읽은 질문의 전체 화면. 홈 질문 카드·대화의 답 대기 카드에서 연다
// 질문은 터미널 화면 그대로라 단계마다 terminal.select 로 한 번씩 보낸다(답 모아 보내기 없음)
Future<void> showTerminalQuestion({
  required BuildContext context,
  required RemoteState state,
  required RemoteAgent agent,
  required VoidCallback onTerminal,
  VoidCallback? onChat,
}) => Navigator.of(context).push<void>(
  MaterialPageRoute(
    builder: (_) => TerminalQuestionScreen(
      state: state,
      agentRef: agent.ref,
      agentName: agent.name,
      agentKind: agent.kind,
      space: agent.space,
      onTerminal: onTerminal,
      onChat: onChat,
    ),
  ),
);

class TerminalQuestionScreen extends StatefulWidget {
  const TerminalQuestionScreen({
    required this.state,
    required this.agentRef,
    required this.agentName,
    required this.agentKind,
    required this.space,
    required this.onTerminal,
    this.onChat,
    super.key,
  });

  final RemoteState state;
  final String agentRef;
  final String agentName;
  final String agentKind;
  final String space;
  final VoidCallback onTerminal;
  // 대화로 이어가는 선택지를 보낸 뒤 그 세션의 대화창을 여는 동작
  final VoidCallback? onChat;

  @override
  State<TerminalQuestionScreen> createState() => _TerminalQuestionScreenState();
}

class _TerminalQuestionScreenState extends State<TerminalQuestionScreen> {
  static const _unlockAfter = Duration(seconds: 5);
  static const _closeAfter = Duration(seconds: 3);

  String? _hash;
  // 단일 선택에서 고른 줄
  int? _picked;
  bool _busy = false;
  // 체크 전환을 보낸 줄. 화면이 바뀌어 새 체크 상태가 올 때까지 체크 자리에 로딩 표시
  int? _pendingRow;
  // 보낸 화면의 식별자. 화면이 바뀔 때까지 입력 잠금
  String? _sentHash;
  bool _sent = false;
  String _lastTitle = '';
  Timer? _unlock;
  Timer? _close;

  @override
  void dispose() {
    _unlock?.cancel();
    _close?.cancel();
    super.dispose();
  }

  RemoteRequest? _find() {
    for (final request in widget.state.terminalQuestions) {
      final body = request.body;
      if (request.agent == widget.agentRef &&
          body is QuestionRequestBody &&
          body.screen != null) {
        return request;
      }
    }
    return null;
  }

  ActiveRemoteSession? get _session =>
      widget.state.supports('terminal.select') ? widget.state.session : null;

  Future<void> _send(RemoteRequest request, TerminalPromptOption option) =>
      _run(
        request,
        (session, screen) async {
          await session.selectTerminal(
            request.agent,
            screen.hash,
            screen.columns,
            screen.rows,
            option.row,
          );
        },
        onSent: () {
          showIrisToast(context, '보냈습니다');
          if (option.role == PromptRole.chat) widget.onChat?.call();
        },
        answered: true,
      );

  // 질문 탭 이동. 터미널의 ←/→ 키를 보내고 화면이 바뀔 때까지 입력 잠금
  Future<void> _move(RemoteRequest request, String key) =>
      _run(request, (session, screen) async {
        await session.keyTerminal(request.agent, key, const KeyModifiers());
      });

  // 보내기 공통: 감시 시작, 동작, 화면 바뀔 때까지 잠금, 오류 안내
  Future<void> _run(
    RemoteRequest request,
    Future<void> Function(ActiveRemoteSession, TerminalPromptScreen) action, {
    VoidCallback? onSent,
    bool answered = false,
  }) async {
    final session = _session;
    if (_busy || session == null) return;
    final screen = (request.body as QuestionRequestBody).screen!;
    setState(() => _busy = true);
    try {
      await session.watchTerminal(request.agent);
      await action(session, screen);
      if (!mounted) return;
      if (answered) _sent = true;
      _sentHash = screen.hash;
      _unlock?.cancel();
      _unlock = Timer(_unlockAfter, () {
        if (mounted) setState(() => _sentHash = null);
      });
      onSent?.call();
    } on RemoteFailure catch (error) {
      if (mounted) {
        showIrisToast(
          context,
          error.message.contains('화면이 바뀌')
              ? '화면이 바뀌었습니다. 새로 고쳐 다시 고르세요'
              : error.message,
          tone: IrisToastTone.error,
        );
      }
    } catch (_) {
      if (mounted) {
        showIrisToast(context, '컴퓨터와 연결이 끊겼습니다.', tone: IrisToastTone.error);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // 질문 이동 조작. 질문이 둘 이상이고 키 전송이 되는 세션에서만 표시
  // 서버가 주는 step 은 답한 수 + 1 이라 현재 탭을 알 수 없음: 첫 질문 판정은 step 과 이전 선택 표시로 함
  ResponseStepNav? _stepNav(
    RemoteRequest request,
    TerminalPromptScreen screen,
    bool locked,
  ) {
    if (screen.steps < 2 || !widget.state.supports('terminal.key')) return null;
    if (_session == null) return null;
    final revisiting = screen.options.any((o) => formatOption(o.text).previous);
    final review = screen.variant == PromptVariant.review;
    final canPrev = review || screen.step > 1 || revisiting;
    final canNext = !review && revisiting;
    return ResponseStepNav(
      onPrev: canPrev && !locked
          ? () => unawaited(_move(request, 'ArrowLeft'))
          : null,
      onNext: canNext && !locked
          ? () => unawaited(_move(request, 'ArrowRight'))
          : null,
    );
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.state,
      builder: (context, _) {
        final request = _find();
        if (request == null) return _ended(context);
        _close?.cancel();
        _close = null;
        final body = request.body as QuestionRequestBody;
        final screen = body.screen!;
        // 터미널 화면이 바뀌면 고른 줄을 비움
        if (_hash != screen.hash) {
          _hash = screen.hash;
          _picked = null;
          _pendingRow = null;
        }
        final agent = widget.state.agent(widget.agentRef);
        final locked = _busy || _sentHash == screen.hash;
        final title = screen.title.isNotEmpty
            ? screen.title
            : (body.questions.isEmpty ? '' : body.questions.first.question);
        final question = screen.tool.isNotEmpty
            ? toolApprovalText(screen.tool, screen.target)
            : formatQuestion(title);
        _lastTitle = question.title;
        final review = screen.variant == PromptVariant.review;
        final multi = screen.options.any((o) => o.checked != null);
        final steps = screen.steps;
        return ResponseFrame(
          header: ResponseHeader.titledNext,
          title: agent?.name ?? widget.agentName,
          space: agent?.space ?? widget.space,
          agentKind: agent?.kind ?? widget.agentKind,
          stepLabel: steps > 1 ? '질문 ${screen.step} / $steps' : null,
          stepNav: _stepNav(request, screen, locked),
          bar: review
              ? _reviewBar(request, screen, locked)
              : (multi
                    ? _multiBar(request, screen, locked)
                    : _singleBar(request, screen, locked)),
          children: [
            _kindRow(request, screen, multi),
            if (steps > 1)
              ResponseProgress(
                count: steps,
                current: screen.step - 1,
                allDone: review,
              ),
            if (review)
              IrisFadeIn(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: _reviewBody(context, screen, title),
                ),
              )
            else ...[
              ResponseTitle(
                question.title,
                key: const Key('terminal-question-title'),
              ),
              if (question.body.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Text(
                    question.body,
                    key: const Key('terminal-question-body'),
                    style: responseLeadStyle(context),
                  ),
                ),
              if (screen.detail.isNotEmpty &&
                  screen.variant == PromptVariant.plan)
                Padding(
                  key: const Key('terminal-prompt-detail'),
                  padding: const EdgeInsets.only(top: 6, bottom: 12),
                  child: IrisMarkdown(joinWrappedLines(screen.detail)),
                )
              else if (screen.detail.isNotEmpty)
                ResponseCodeBox(
                  key: const Key('terminal-prompt-detail'),
                  text: screen.detail,
                  prompt: null,
                  fontSize: 13.5,
                ),
              ..._options(request, screen, body, multi, locked),
            ],
          ],
        );
      },
    );
  }

  Widget _kindRow(
    RemoteRequest request,
    TerminalPromptScreen screen,
    bool multi,
  ) {
    final steps = screen.steps;
    final variant = screen.variant;
    final String label;
    if (variant == PromptVariant.review) {
      label = steps > 1 ? '질문 $steps개 · 제출 전 확인' : '제출 전 확인';
    } else if (variant != PromptVariant.choice) {
      label = TerminalQuestionCard.variantLabel(variant);
    } else if (steps > 1) {
      label = '질문 $steps개 · ${screen.step}번째';
    } else {
      label = multi ? '질문 · 여러 개 선택' : '질문 · 하나 고르기';
    }
    final asked =
        variant == PromptVariant.choice || variant == PromptVariant.review;
    return ResponseKindRow(
      label: label,
      tone: asked ? ResponseTone.question : ResponseTone.approval,
      glyph: asked ? '?' : null,
      icon: asked ? null : TerminalQuestionCard.variantIcon(variant),
      time: responseAgo(request.createdAt),
    );
  }

  List<Widget> _reviewBody(
    BuildContext context,
    TerminalPromptScreen screen,
    String title,
  ) {
    final text = screen.detail.isNotEmpty ? screen.detail : title;
    final answers = parseReviewAnswers(screen.detail);
    return [
      const ResponseTitle('이대로 보낼까요?'),
      Text('제출하면 에이전트에게 전달됩니다.', style: responseLeadStyle(context)),
      if (text.isNotEmpty) ...[
        const ResponseSectionLabel('답'),
        if (answers.isNotEmpty || reviewWarning(screen.detail) != null)
          Container(
            key: const Key('terminal-prompt-detail'),
            margin: const EdgeInsets.only(top: 10, bottom: 6),
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: context.iris.level2,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (answers.isNotEmpty) ReviewAnswersList(answers: answers),
                if (reviewWarning(screen.detail) != null)
                  Padding(
                    padding: EdgeInsets.only(top: answers.isEmpty ? 0 : 12),
                    child: Text(
                      reviewWarning(screen.detail)!,
                      style: TextStyle(color: context.iris.pink, fontSize: 14),
                    ),
                  ),
              ],
            ),
          )
        else
          ResponseCodeBox(
            key: const Key('terminal-prompt-detail'),
            text: text,
            prompt: null,
            fontSize: 13.5,
          ),
      ],
    ];
  }

  // 선택지 설명은 줄에 없으면 질문 본문의 같은 이름 선택지에서 가져옴
  String _description(TerminalPromptOption option, QuestionRequestBody body) {
    if (option.description.isNotEmpty) return option.description;
    final label = formatOption(option.text).label;
    for (final question in body.questions) {
      for (final candidate in question.options) {
        if (formatOption(candidate.label).label == label) {
          return candidate.description;
        }
      }
    }
    return '';
  }

  // 체크 선택지가 있는 화면에서 다음·제출 줄. 체크 없는 선택 가능한 줄 중 고른다
  TerminalPromptOption? _advance(TerminalPromptScreen screen) {
    final rows = [
      for (final o in screen.options)
        if (o.checked == null &&
            o.selectable &&
            o.role != PromptRole.deny &&
            o.role != PromptRole.chat)
          o,
    ];
    if (rows.isEmpty) return null;
    final named = rows.where(
      (o) => RegExp(
        r'next|submit|done|continue|다음|제출|완료|계속',
        caseSensitive: false,
      ).hasMatch(o.text),
    );
    return named.isNotEmpty ? named.first : rows.last;
  }

  // 질문이 여러 개인 선택형은 고르면 바로 다음 질문으로 넘어감, 승인류는 확인 뒤 전송
  bool _advancesOnPick(
    TerminalPromptScreen screen,
    TerminalPromptOption option,
  ) =>
      screen.steps > 1 &&
      screen.variant == PromptVariant.choice &&
      (option.role == PromptRole.choice || option.role == PromptRole.deny);

  List<Widget> _options(
    RemoteRequest request,
    TerminalPromptScreen screen,
    QuestionRequestBody body,
    bool multi,
    bool locked,
  ) {
    final advance = multi ? _advance(screen) : null;
    final shown = [
      for (final option in screen.options)
        if (option.row != advance?.row) option,
    ];
    final checkedCount = screen.options.where((o) => o.checked == true).length;
    final out = <Widget>[
      if (multi)
        ResponseSectionLabel(
          '선택지 ${screen.options.where((o) => o.checked != null).length}개',
          inline: true,
          trailing: Text(
            '선택 $checkedCount개',
            style: TextStyle(
              color: context.iris.muted,
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
          ),
        )
      else
        const ResponseSectionLabel('답'),
    ];
    for (var i = 0; i < shown.length; i++) {
      final option = shown[i];
      if (i > 0) out.add(const SizedBox(height: 8));
      final view = formatOption(
        option.text,
        description: _description(option, body),
      );
      final text = option.role == PromptRole.text || !option.selectable;
      final description = text ? '터미널에서 입력' : view.description;
      out.add(
        ResponseOption(
          key: Key('terminal-option-${option.row}'),
          title: view.label,
          recommended: view.recommended,
          previous: view.previous,
          description: description,
          multi: option.checked != null,
          negative: option.role == PromptRole.deny,
          selected: option.checked ?? (_picked == option.row),
          loading:
              option.checked != null && locked && _pendingRow == option.row,
          onTap: locked
              ? null
              : () {
                  if (text || _session == null) {
                    widget.onTerminal();
                  } else if (option.checked != null ||
                      option.role == PromptRole.chat ||
                      _advancesOnPick(screen, option)) {
                    // 체크 전환·대화 이동·여러 질문의 단일 선택은 고르는 즉시 전송
                    setState(() => _pendingRow = option.row);
                    unawaited(_send(request, option));
                  } else {
                    setState(() => _picked = option.row);
                  }
                },
        ),
      );
    }
    return out;
  }

  IrisButton _later(bool locked) => IrisButton(
    key: const Key('terminal-question-later'),
    label: '나중에',
    tone: IrisButtonTone.ghost,
    onPressed: locked ? null : () => Navigator.of(context).maybePop(),
  );

  Widget _singleBar(
    RemoteRequest request,
    TerminalPromptScreen screen,
    bool locked,
  ) {
    final picked = screen.options.where((o) => o.row == _picked);
    final option = picked.isEmpty ? null : picked.first;
    final String label;
    if (_session == null) {
      label = '터미널에서 답하기';
    } else if (_busy) {
      label = '보내는 중…';
    } else if (option == null) {
      label = '답을 고르세요';
    } else {
      label = '‘${_short(formatOption(option.text).label)}’ 보내기';
    }
    return IrisActionBar(
      buttons: [
        _later(locked),
        IrisButton(
          key: const Key('terminal-question-send'),
          label: label,
          tone: IrisButtonTone.primary,
          onPressed: _session == null
              ? widget.onTerminal
              : (option == null || locked
                    ? null
                    : () => unawaited(_send(request, option))),
        ),
      ],
    );
  }

  Widget _multiBar(
    RemoteRequest request,
    TerminalPromptScreen screen,
    bool locked,
  ) {
    final advance = _advance(screen);
    final count = screen.options.where((o) => o.checked == true).length;
    final raw = advance == null
        ? ''
        : TerminalQuestionCard.optionText(advance.text);
    final base = RegExp(r'submit|제출', caseSensitive: false).hasMatch(raw)
        ? '제출'
        : '다음';
    final String label;
    if (_session == null || advance == null) {
      label = '터미널에서 계속';
    } else if (_busy) {
      label = '보내는 중…';
    } else {
      label = count > 0 ? '$base · $count개 선택' : base;
    }
    return IrisActionBar(
      buttons: [
        _later(locked),
        IrisButton(
          key: const Key('terminal-question-send'),
          label: label,
          tone: IrisButtonTone.primary,
          onPressed: _session == null || advance == null
              ? widget.onTerminal
              : (locked ? null : () => unawaited(_send(request, advance))),
        ),
      ],
    );
  }

  Widget _reviewBar(
    RemoteRequest request,
    TerminalPromptScreen screen,
    bool locked,
  ) {
    final selectable = [
      for (final o in screen.options)
        if (o.selectable) o,
    ];
    TerminalPromptOption? role(PromptRole role) {
      for (final o in selectable) {
        if (o.role == role) return o;
      }
      return null;
    }

    final cancel = role(PromptRole.deny);
    final submit =
        role(PromptRole.allow) ??
        selectable.where((o) => o != cancel).firstOrNull;
    return IrisActionBar(
      buttons: [
        IrisButton(
          key: const Key('terminal-question-cancel'),
          label: '취소',
          tone: IrisButtonTone.ghost,
          onPressed: cancel == null || locked || _session == null
              ? null
              : () => unawaited(_send(request, cancel)),
        ),
        IrisButton(
          key: const Key('terminal-question-submit'),
          label: _session == null ? '터미널에서 제출' : (_busy ? '보내는 중…' : '제출'),
          tone: IrisButtonTone.primary,
          onPressed: _session == null
              ? widget.onTerminal
              : (submit == null || locked
                    ? null
                    : () => unawaited(_send(request, submit))),
        ),
      ],
    );
  }

  static String _short(String text) =>
      text.length <= 18 ? text : '${text.substring(0, 17)}…';

  // 질문이 사라진 뒤 화면. 보낸 직후면 다음 단계 질문을 잠시 기다린 뒤 닫음
  Widget _ended(BuildContext context) {
    if (_sent && _close == null) {
      _close = Timer(_closeAfter, () {
        if (mounted) Navigator.of(context).maybePop();
      });
    }
    final String title = _sent ? '보냈습니다' : '질문이 끝났습니다';
    return ResponseFrame(
      header: ResponseHeader.titledNext,
      title: widget.agentName,
      space: widget.space,
      agentKind: widget.agentKind,
      bar: responseAnsweredBar(
        onHome: () => Navigator.of(context).maybePop(),
        remaining: 0,
        onNext: null,
      ),
      children: [
        ResponseAnswered(
          title: title,
          detail: _sent ? '다음 질문이 있으면 이어서 표시합니다' : '답했거나 취소되어 질문이 닫혔습니다',
          badge: _sent ? '보냄' : '종료',
          kindLabel: '질문',
          kindIcon: 'check-circle',
          kindTone: ResponseTone.question,
          kindGlyph: '?',
          ghost: responseGhostCode(context, _lastTitle),
        ),
      ],
    );
  }
}
