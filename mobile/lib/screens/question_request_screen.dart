import 'package:flutter/material.dart';
import 'package:iris_remote/design/agent_tile.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/markdown_text.dart';
import 'package:iris_remote/design/sheet.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/format/result_text.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/state/remote_state.dart';

Future<void> showQuestionRequestSheet({
  required BuildContext context,
  required RemoteRequest request,
  required RemoteState state,
  required String agentName,
  required String agentKind,
  required String space,
}) async {
  final body = request.body as QuestionRequestBody;
  await showIrisSheet<void>(
    context: context,
    builder: (_) => QuestionRequestSheet(
      request: request,
      agentName: agentName,
      agentKind: agentKind,
      space: space,
      onAnswer: (responses) => state.answerQuestions(request, body, responses),
    ),
  );
}

class QuestionRequestSheet extends StatefulWidget {
  const QuestionRequestSheet({
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
  final Future<RequestAnswerResult> Function(List<QuestionResponse> responses)
  onAnswer;

  @override
  State<QuestionRequestSheet> createState() => _QuestionRequestSheetState();
}

class _QuestionRequestSheetState extends State<QuestionRequestSheet> {
  late final QuestionRequestBody _body;
  late final List<Set<String>> _selected;
  late final List<TextEditingController> _textControllers;
  late final List<bool> _directSelected;
  int _index = 0;
  bool _busy = false;
  String? _result;

  @override
  void initState() {
    super.initState();
    _body = widget.request.body as QuestionRequestBody;
    _selected = List.generate(_body.questions.length, (_) => <String>{});
    _directSelected = List.filled(_body.questions.length, false);
    _textControllers = List.generate(
      _body.questions.length,
      (_) => TextEditingController(),
    );
  }

  @override
  void dispose() {
    for (final controller in _textControllers) {
      controller.dispose();
    }
    super.dispose();
  }

  void _toggle(String label) {
    final question = _body.questions[_index];
    setState(() {
      if (question.multiSelect) {
        if (!_selected[_index].add(label)) _selected[_index].remove(label);
      } else {
        _directSelected[_index] = false;
        _selected[_index]
          ..clear()
          ..add(label);
        _textControllers[_index].clear();
      }
    });
  }

  bool get _currentComplete {
    final question = _body.questions[_index];
    return _selected[_index].isNotEmpty ||
        (!question.multiSelect &&
            _directSelected[_index] &&
            _textControllers[_index].text.isNotEmpty);
  }

  Future<void> _next() async {
    if (!_currentComplete || _busy) return;
    if (_index < _body.questions.length - 1) {
      setState(() => _index++);
      return;
    }
    final responses = <QuestionResponse>[];
    for (var index = 0; index < _body.questions.length; index++) {
      final text = _textControllers[index].text;
      if (text.isNotEmpty) {
        responses.add(QuestionText(text));
      } else {
        responses.add(
          QuestionLabels([
            for (final option in _body.questions[index].options)
              if (_selected[index].contains(option.label)) option.label,
          ]),
        );
      }
    }
    setState(() => _busy = true);
    try {
      final result = await widget.onAnswer(responses);
      if (!mounted) return;
      setState(() => _result = requestAnswerResultText(result.result));
      if (result.result == 'delivered' ||
          result.result == 'already-answered' ||
          result.result == 'expired') {
        Navigator.of(context).pop();
      }
    } on ProtocolException catch (error) {
      if (mounted) setState(() => _result = error.message);
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _result = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final question = _body.questions[_index];
    return SizedBox(
      height: 497,
      child: Column(
        children: [
          const IrisSheetGrabber(barKey: Key('question-grabber')),
          const SizedBox(height: 14),
          SizedBox(
            key: const Key('question-header'),
            height: 35,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Row(
                children: [
                  IrisAgentTile(
                    key: const Key('question-tile'),
                    kind: widget.agentKind,
                    status: 'question',
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
                          '${widget.space} · 9분 전',
                          style: TextStyle(
                            color: context.iris.muted,
                            fontSize: 13,
                            height: 16 / 13,
                          ),
                        ),
                      ],
                    ),
                  ),
                  SizedBox(
                    key: const Key('question-progress'),
                    width: 27.3,
                    child: ClipRect(
                      child: Text(
                        '${_index + 1} / ${_body.questions.length}',
                        maxLines: 1,
                        style: TextStyle(
                          color: context.iris.muted,
                          fontSize: 13,
                          height: 16 / 13,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          Padding(
            key: const Key('question-title'),
            padding: const EdgeInsets.fromLTRB(4, 14, 4, 0),
            child: IrisMarkdown(
              question.question,
              compact: true,
              baseStyle: TextStyle(
                color: context.iris.foreground,
                fontSize: 21,
                fontWeight: FontWeight.w700,
                height: 1.35,
                letterSpacing: -0.42,
              ),
            ),
          ),
          SizedBox(
            key: const Key('question-note'),
            height: 27.75,
            width: double.infinity,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(4, 6, 4, 0),
              child: Text(
                question.multiSelect ? '여러 개 고를 수 있습니다' : '하나를 골라 주세요',
                style: TextStyle(
                  color: context.iris.muted,
                  fontSize: 14.5,
                  height: 1.5,
                ),
              ),
            ),
          ),
          const SizedBox(height: 14),
          Expanded(
            child: ListView.separated(
              key: const Key('question-options'),
              physics: const ClampingScrollPhysics(),
              padding: EdgeInsets.zero,
              itemCount:
                  question.options.length +
                  (!question.multiSelect &&
                          !question.options.any(
                            (option) => option.label == '직접 입력',
                          )
                      ? 1
                      : 0),
              separatorBuilder: (_, _) => const SizedBox(height: 8),
              itemBuilder: (context, optionIndex) {
                if (optionIndex == question.options.length) {
                  return _QuestionOption(
                    label: '직접 입력',
                    description: '',
                    selected: _directSelected[_index],
                    square: false,
                    controller: _textControllers[_index],
                    onTap: () => setState(() {
                      _selected[_index].clear();
                      _directSelected[_index] = true;
                    }),
                    onChanged: (_) => setState(() {}),
                  );
                }
                final option = question.options[optionIndex];
                final direct = !question.multiSelect && option.label == '직접 입력';
                return _QuestionOption(
                  key: optionIndex == 0
                      ? const Key('question-option-first')
                      : null,
                  label: option.label,
                  description: option.description,
                  selected: direct
                      ? _directSelected[_index]
                      : _selected[_index].contains(option.label),
                  square: question.multiSelect,
                  controller: direct ? _textControllers[_index] : null,
                  onChanged: direct ? (_) => setState(() {}) : null,
                  onTap: direct
                      ? () => setState(() {
                          _selected[_index].clear();
                          _directSelected[_index] = true;
                        })
                      : () => _toggle(option.label),
                );
              },
            ),
          ),
          SizedBox(
            key: const Key('question-footer'),
            height: 64,
            child: Padding(
              padding: const EdgeInsets.only(top: 14),
              child: Row(
                children: [
                  if (_index > 0) ...[
                    SizedBox(
                      width: 96,
                      child: IrisButton(
                        label: '이전',
                        expand: false,
                        onPressed: () => setState(() => _index--),
                      ),
                    ),
                    const SizedBox(width: 10),
                  ],
                  IrisButton(
                    key: const Key('question-next'),
                    label: _busy
                        ? '보내는 중…'
                        : (_index == _body.questions.length - 1 ? '보내기' : '다음'),
                    tone: IrisButtonTone.primary,
                    onPressed: _currentComplete ? _next : null,
                  ),
                ],
              ),
            ),
          ),
          SizedBox(
            key: const Key('question-dots'),
            height: 20,
            child: Padding(
              padding: const EdgeInsets.only(top: 14),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  for (var dot = 0; dot < _body.questions.length; dot++) ...[
                    AnimatedContainer(
                      duration: const Duration(milliseconds: 180),
                      width: dot == _index ? 18 : 6,
                      height: 6,
                      decoration: BoxDecoration(
                        color: dot == _index
                            ? context.iris.foreground
                            : context.iris.level3,
                        borderRadius: BorderRadius.circular(3),
                      ),
                    ),
                    if (dot != _body.questions.length - 1)
                      const SizedBox(width: 6),
                  ],
                ],
              ),
            ),
          ),
          if (_result != null)
            Text(_result!, style: TextStyle(color: context.iris.muted)),
        ],
      ),
    );
  }
}

class _QuestionOption extends StatelessWidget {
  const _QuestionOption({
    required this.label,
    required this.description,
    required this.selected,
    required this.square,
    required this.onTap,
    this.controller,
    this.onChanged,
    super.key,
  });

  final String label;
  final String description;
  final bool selected;
  final bool square;
  final VoidCallback onTap;
  final TextEditingController? controller;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    final hasDescription = description.isNotEmpty;
    final expandedInput = controller != null && selected;
    final minimumHeight = expandedInput
        ? 102.0
        : (hasDescription ? 68.0 : 49.0);
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        constraints: BoxConstraints(minHeight: minimumHeight),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: selected
              ? context.iris.brand.withValues(alpha: 0.10)
              : context.iris.level2,
          borderRadius: BorderRadius.circular(16),
        ),
        foregroundDecoration: selected
            ? BoxDecoration(
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: context.iris.brand, width: 1.5),
              )
            : null,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 22,
              height: 22,
              margin: const EdgeInsets.only(top: 1),
              decoration: BoxDecoration(
                color: selected ? context.iris.brand : Colors.transparent,
                borderRadius: BorderRadius.circular(square ? 7 : 11),
                border: selected
                    ? null
                    : Border.all(color: context.iris.level3, width: 2),
              ),
              alignment: Alignment.center,
              child: selected
                  ? IrisIcon('check', size: 13, color: context.iris.onBrand)
                  : null,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    label,
                    style: TextStyle(
                      color: context.iris.foreground,
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                      height: 1.2,
                      letterSpacing: -0.16,
                    ),
                  ),
                  if (hasDescription)
                    Padding(
                      padding: const EdgeInsets.only(top: 3),
                      child: IrisMarkdown(
                        description,
                        compact: true,
                        selectable: false,
                        baseStyle: TextStyle(
                          color: context.iris.muted,
                          fontSize: 14,
                          height: 1.45,
                        ),
                        textColor: context.iris.muted,
                      ),
                    ),
                  if (expandedInput)
                    SizedBox(
                      height: 40,
                      child: TextField(
                        key: const Key('question-direct-input'),
                        controller: controller,
                        autofocus: true,
                        maxLength: 2000,
                        onChanged: onChanged,
                        style: TextStyle(
                          color: context.iris.foreground,
                          fontSize: 15,
                        ),
                        decoration: InputDecoration(
                          hintText: '에이전트에게 보낼 답',
                          counterText: '',
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 12,
                          ),
                          filled: true,
                          fillColor: context.iris.level1,
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(10),
                            borderSide: BorderSide.none,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
