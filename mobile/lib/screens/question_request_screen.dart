import 'package:flutter/material.dart';
import 'package:iris_remote/design/action_bar.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/markdown_text.dart';
import 'package:iris_remote/design/motion.dart';
import 'package:iris_remote/design/toast.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/format/result_text.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/response_host.dart';
import 'package:iris_remote/screens/response_kit.dart';
import 'package:iris_remote/state/remote_state.dart';

// 반환값은 거절로 끝난 마지막 요청의 에이전트(없으면 null)
Future<String?> showQuestionRequestSheet({
  required BuildContext context,
  required RemoteRequest request,
  required RemoteState state,
  required String agentName,
  required String agentKind,
  required String space,
}) {
  return showResponseHost(
    context: context,
    state: state,
    request: request,
    agentName: agentName,
    agentKind: agentKind,
    space: space,
  );
}

// 질문 답 초안. 요청 사이를 오가도 선택·입력·진행 위치를 보존하려고 호스트가 소유
class QuestionDraft {
  QuestionDraft(int count)
    : selected = List.generate(count, (_) => <String>{}),
      directSelected = List.filled(count, false),
      controllers = List.generate(count, (_) => TextEditingController());

  final List<Set<String>> selected;
  final List<bool> directSelected;
  final List<TextEditingController> controllers;
  int index = 0;
  // 질문이 둘 이상일 때 마지막 질문 뒤의 제출 확인 단계
  bool review = false;

  void dispose() {
    for (final controller in controllers) {
      controller.dispose();
    }
  }
}

class QuestionRequestSheet extends StatefulWidget {
  const QuestionRequestSheet({
    required this.request,
    required this.agentName,
    required this.agentKind,
    required this.space,
    required this.onAnswer,
    this.nav,
    this.closedAs,
    this.draft,
    super.key,
  });

  final RemoteRequest request;
  final String agentName;
  final String agentKind;
  final String space;
  final Future<RequestAnswerResult> Function(List<QuestionResponse> responses)
  onAnswer;
  final ResponseNav? nav;
  // 목록에서 사라진 요청. gone 은 이유 불명, gone-expired 는 만료 시각이 지난 경우
  final String? closedAs;
  // 비우면 이 화면이 직접 만들고 닫을 때 버림
  final QuestionDraft? draft;

  @override
  State<QuestionRequestSheet> createState() => _QuestionRequestSheetState();
}

class _QuestionRequestSheetState extends State<QuestionRequestSheet> {
  late final QuestionRequestBody _body;
  late final QuestionDraft _draft;
  QuestionDraft? _ownDraft;
  bool _busy = false;
  String? _gone;

  @override
  void initState() {
    super.initState();
    _body = widget.request.body as QuestionRequestBody;
    _draft =
        widget.draft ?? (_ownDraft = QuestionDraft(_body.questions.length));
  }

  @override
  void dispose() {
    _ownDraft?.dispose();
    super.dispose();
  }

  int get _total => _body.questions.length;

  void _toggle(String label) {
    if (_busy) return;
    final question = _body.questions[_draft.index];
    final chosen = _draft.selected[_draft.index];
    setState(() {
      if (question.multiSelect) {
        if (!chosen.add(label)) chosen.remove(label);
      } else {
        _draft.directSelected[_draft.index] = false;
        chosen
          ..clear()
          ..add(label);
        _draft.controllers[_draft.index].clear();
      }
    });
  }

  void _selectDirect() {
    if (_busy) return;
    setState(() {
      _draft.selected[_draft.index].clear();
      _draft.directSelected[_draft.index] = true;
    });
  }

  bool _complete(int index) {
    final question = _body.questions[index];
    return _draft.selected[index].isNotEmpty ||
        (!question.multiSelect &&
            _draft.directSelected[index] &&
            _draft.controllers[index].text.isNotEmpty);
  }

  String _answerText(int index) {
    final text = _draft.controllers[index].text;
    if (text.isNotEmpty) return text;
    return [
      for (final option in _body.questions[index].options)
        if (_draft.selected[index].contains(option.label)) option.label,
    ].join(' · ');
  }

  Future<void> _next() async {
    if (!_complete(_draft.index) || _busy) return;
    if (_total > 1) {
      setState(() {
        if (_draft.index < _total - 1) {
          _draft.index++;
        } else {
          _draft.review = true;
        }
      });
      return;
    }
    await _submit();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final responses = <QuestionResponse>[];
    for (var index = 0; index < _total; index++) {
      final text = _draft.controllers[index].text;
      if (text.isNotEmpty) {
        responses.add(QuestionText(text));
      } else {
        responses.add(
          QuestionLabels([
            for (final option in _body.questions[index].options)
              if (_draft.selected[index].contains(option.label)) option.label,
          ]),
        );
      }
    }
    setState(() => _busy = true);
    try {
      final result = await widget.onAnswer(responses);
      if (!mounted) return;
      switch (result.result) {
        case 'delivered':
          showIrisToast(context, '에이전트에게 보냈습니다');
          Navigator.of(context).pop();
        case 'already-answered' || 'expired':
          setState(() => _gone = result.result);
        default:
          showIrisToast(
            context,
            requestAnswerResultText(result.result),
            tone: IrisToastTone.error,
          );
      }
    } on ProtocolException catch (error) {
      if (mounted) {
        showIrisToast(context, error.message, tone: IrisToastTone.error);
      }
    } on RemoteFailure catch (error) {
      if (mounted) {
        showIrisToast(context, error.message, tone: IrisToastTone.error);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final gone = _gone ?? (_busy ? null : widget.closedAs);
    if (gone != null) return _answered(context, gone);
    final children = _draft.review
        ? _reviewBody(context)
        : _questionBody(context);
    return ResponseFrame(
      header: ResponseHeader.titledNext,
      title: widget.agentName,
      space: widget.space,
      agentKind: widget.agentKind,
      nav: widget.nav,
      bar: _draft.review ? _reviewBar(context) : _questionBar(context),
      children: children,
    );
  }

  String get _kindLabel {
    if (_total == 1) {
      return _body.questions.first.multiSelect ? '질문 · 여러 개 선택' : '질문 · 하나 고르기';
    }
    return _draft.review
        ? '질문 $_total개 · 제출 전 확인'
        : '질문 $_total개 · ${_draft.index + 1}번째';
  }

  Widget _kindRow() => ResponseKindRow(
    label: _kindLabel,
    tone: ResponseTone.question,
    glyph: '?',
    time: responseAgo(widget.request.createdAt),
  );

  List<Widget> _questionBody(BuildContext context) {
    final colors = context.iris;
    final question = _body.questions[_draft.index];
    final hasDirect = question.options.any((o) => o.label == '직접 입력');
    final addDirect = !question.multiSelect && !hasDirect;
    final count = question.options.length + (addDirect ? 1 : 0);
    final allSelected =
        question.multiSelect && _draft.selected[_draft.index].length == count;
    return [
      _kindRow(),
      if (_total > 1) ResponseProgress(count: _total, current: _draft.index),
      if (_total > 1 && _draft.index > 0)
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: ResponseAnswerCard(
            key: const Key('question-previous-answer'),
            question:
                '$_draft.index. ${_body.questions[_draft.index - 1].question}',
            answer: _answerText(_draft.index - 1),
          ),
        ),
      Padding(
        key: const Key('question-title'),
        padding: EdgeInsets.only(
          top: _total > 1 && _draft.index > 0 ? 20 : 14,
          bottom: 8,
        ),
        child: IrisMarkdown(
          question.question,
          compact: true,
          baseStyle: TextStyle(
            color: colors.foreground,
            fontSize: 22,
            fontWeight: FontWeight.w700,
            height: 1.38,
            letterSpacing: -0.33,
          ),
        ),
      ),
      if (question.multiSelect)
        ResponseSectionLabel(
          '선택지 ${question.options.length}개',
          inline: true,
          trailing: GestureDetector(
            key: const Key('question-select-all'),
            behavior: HitTestBehavior.opaque,
            onTap: _busy
                ? null
                : () => setState(() {
                    if (allSelected) {
                      _draft.selected[_draft.index].clear();
                    } else {
                      _draft.selected[_draft.index].addAll(
                        question.options.map((o) => o.label),
                      );
                    }
                  }),
            child: Text(
              allSelected ? '선택 해제' : '모두 선택',
              style: TextStyle(
                color: colors.link,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        )
      else
        const ResponseSectionLabel('답'),
      for (var i = 0; i < count; i++) ...[
        if (i > 0) const SizedBox(height: 8),
        _option(context, question, i),
      ],
      if (_total > 1 && _draft.index < _total - 1) ...[
        const ResponseSectionLabel('남은 질문'),
        for (var i = _draft.index + 1; i < _total; i++)
          ResponseAnswerCard(
            number: i + 1,
            todo: true,
            question: _body.questions[i].question,
            answer: _complete(i) ? _answerText(i) : '아직 답하지 않음',
          ),
      ],
    ];
  }

  Widget _option(BuildContext context, RequestQuestion question, int i) {
    final extraDirect = i == question.options.length;
    final option = extraDirect ? null : question.options[i];
    final direct =
        !question.multiSelect && (extraDirect || option!.label == '직접 입력');
    final selected = direct
        ? _draft.directSelected[_draft.index]
        : _draft.selected[_draft.index].contains(option!.label);
    return ResponseOption(
      key: i == 0 ? const Key('question-option-first') : null,
      title: option?.label ?? '직접 입력',
      description: option?.description ?? '',
      multi: question.multiSelect,
      selected: selected,
      onTap: _busy
          ? null
          : (direct ? _selectDirect : () => _toggle(option!.label)),
      extra: direct && selected ? _directField(context) : null,
    );
  }

  Widget _directField(BuildContext context) {
    final colors = context.iris;
    return TextField(
      key: const Key('question-direct-input'),
      controller: _draft.controllers[_draft.index],
      autofocus: true,
      enabled: !_busy,
      maxLength: 2000,
      minLines: 1,
      maxLines: 4,
      onChanged: (_) => setState(() {}),
      style: TextStyle(color: colors.foreground, fontSize: 15, height: 1.45),
      decoration: InputDecoration(
        hintText: '에이전트에게 보낼 답',
        hintStyle: TextStyle(color: colors.muted),
        counterText: '',
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 14,
          vertical: 12,
        ),
        filled: true,
        fillColor: colors.level2,
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: colors.line2),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: colors.strong, width: 1.5),
        ),
      ),
    );
  }

  Widget _questionBar(BuildContext context) {
    final question = _body.questions[_draft.index];
    final complete = _complete(_draft.index);
    final last = _draft.index == _total - 1;
    final String label;
    if (_busy) {
      label = '보내는 중…';
    } else if (!complete) {
      label = question.multiSelect ? '하나 이상 고르세요' : '답을 고르세요';
    } else if (_total > 1) {
      label = last ? '확인하고 제출' : '다음';
    } else if (question.multiSelect) {
      label = '선택한 ${_draft.selected[_draft.index].length}개 보내기';
    } else if (_draft.controllers[_draft.index].text.isNotEmpty) {
      label = '입력한 답 보내기';
    } else {
      label = '‘${_draft.selected[_draft.index].first}’ 보내기';
    }
    return IrisActionBar(
      buttons: [
        if (_draft.index > 0)
          IrisButton(
            key: const Key('question-previous'),
            label: '이전',
            tone: IrisButtonTone.secondary,
            onPressed: _busy ? null : () => setState(() => _draft.index--),
          )
        else
          IrisButton(
            key: const Key('question-later'),
            label: '나중에',
            tone: IrisButtonTone.ghost,
            onPressed: _busy ? null : () => Navigator.of(context).maybePop(),
          ),
        IrisButton(
          key: const Key('question-next'),
          label: label,
          tone: IrisButtonTone.primary,
          onPressed: complete && !_busy ? _next : null,
        ),
      ],
    );
  }

  // 제출 확인 단계 진입: 본문 전체 페이드
  List<Widget> _reviewBody(BuildContext context) {
    return [
      IrisFadeIn(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: _reviewItems(context),
        ),
      ),
    ];
  }

  List<Widget> _reviewItems(BuildContext context) {
    return [
      _kindRow(),
      ResponseProgress(count: _total, current: _total, allDone: true),
      const ResponseTitle('이대로 보낼까요?'),
      Text('고친 답은 제출하기 전까지 컴퓨터에 전달되지 않습니다.', style: responseLeadStyle(context)),
      ResponseSectionLabel('답 $_total개'),
      for (var i = 0; i < _total; i++)
        ResponseAnswerCard(
          key: Key('question-review-$i'),
          question: '${i + 1}. ${_body.questions[i].question}',
          answer: _answerText(i),
          onEdit: _busy
              ? null
              : () => setState(() {
                  _draft.index = i;
                  _draft.review = false;
                }),
        ),
    ];
  }

  Widget _reviewBar(BuildContext context) => IrisActionBar(
    buttons: [
      IrisButton(
        key: const Key('question-review-cancel'),
        label: '취소',
        tone: IrisButtonTone.ghost,
        onPressed: _busy ? null : () => setState(() => _draft.review = false),
      ),
      IrisButton(
        key: const Key('question-submit'),
        label: _busy ? '보내는 중…' : '제출',
        tone: IrisButtonTone.primary,
        onPressed: _busy ? null : _submit,
      ),
    ],
  );

  Widget _answered(BuildContext context, String gone) {
    final remaining = gone.startsWith('gone')
        ? (widget.nav?.count ?? 0)
        : ((widget.nav?.count ?? 1) - 1).clamp(0, 99);
    return ResponseFrame(
      header: ResponseHeader.titledNext,
      title: widget.agentName,
      space: widget.space,
      agentKind: widget.agentKind,
      bar: responseAnsweredBar(
        onHome: () => Navigator.of(context).pop(),
        remaining: remaining,
        onNext: widget.nav?.onNext,
      ),
      children: [
        ResponseAnswered(
          title: responseGoneText(gone).$1,
          detail: responseGoneText(gone).$2,
          badge: responseGoneBadge(gone),
          kindLabel: _total > 1 ? '질문 $_total개' : '질문',
          kindIcon: 'check-circle',
          kindTone: ResponseTone.question,
          kindGlyph: '?',
          ghost: responseGhostCode(context, _body.questions.first.question),
        ),
      ],
    );
  }
}
