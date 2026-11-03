import 'package:flutter/material.dart';
import 'package:iris_remote/design/action_bar.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/toast.dart';
import 'package:iris_remote/format/control_characters.dart';
import 'package:iris_remote/format/result_text.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/response_host.dart';
import 'package:iris_remote/screens/response_kit.dart';
import 'package:iris_remote/state/remote_state.dart';

Future<String?> showPermissionRequestSheet({
  required BuildContext context,
  required RemoteRequest request,
  required RemoteState state,
  required String agentName,
  required String agentKind,
  required String space,
}) => showResponseHost(
  context: context,
  state: state,
  request: request,
  agentName: agentName,
  agentKind: agentKind,
  space: space,
);

enum _Variant { command, edit, tool }

_Variant _variantOf(String tool) {
  final name = tool.toLowerCase();
  if (name.startsWith('mcp__')) return _Variant.tool;
  if (const {
    'edit',
    'write',
    'multiedit',
    'notebookedit',
    'apply_patch',
  }.contains(name)) {
    return _Variant.edit;
  }
  return _Variant.command;
}

// 요청 목록·대화 카드에서 쓰는 승인 종류 이름
String permissionKindLabel(String tool) => switch (_variantOf(tool)) {
  _Variant.command => '명령 실행 승인',
  _Variant.edit => '파일 수정 승인',
  _Variant.tool => tool.startsWith('mcp__') ? 'MCP 도구 승인' : '도구 사용 승인',
};

// mcp__서버__도구 형태를 서버와 도구로 나눔
(String?, String) _splitTool(String tool) {
  final match = RegExp(r'^mcp__(.+?)__(.+)$').firstMatch(tool);
  return match == null ? (null, tool) : (match.group(1), match.group(2)!);
}

class PermissionRequestSheet extends StatefulWidget {
  const PermissionRequestSheet({
    required this.request,
    required this.agentName,
    required this.agentKind,
    required this.space,
    required this.onAnswer,
    this.nav,
    this.closedAs,
    this.initialChoice,
    this.onChoice,
    super.key,
  });

  final RemoteRequest request;
  final String agentName;
  final String agentKind;
  final String space;
  final Future<RequestAnswerResult> Function(bool allow) onAnswer;
  final ResponseNav? nav;
  // 목록에서 사라진 요청. gone 은 이유 불명, gone-expired 는 만료 시각이 지난 경우
  final String? closedAs;
  // 요청 사이를 오가도 고른 답을 보존: 0 허용, 1 거절
  final int? initialChoice;
  final ValueChanged<int>? onChoice;

  @override
  State<PermissionRequestSheet> createState() => _PermissionRequestSheetState();
}

class _PermissionRequestSheetState extends State<PermissionRequestSheet> {
  bool _busy = false;
  // 0 허용, 1 거절
  late int? _choice = widget.initialChoice;
  String? _gone;

  void _pick(int choice) {
    setState(() => _choice = choice);
    widget.onChoice?.call(choice);
  }

  PermissionRequestBody get _body =>
      widget.request.body as PermissionRequestBody;

  Future<void> _answer(bool allow) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final result = await widget.onAnswer(allow);
      if (!mounted) return;
      switch (result.result) {
        case 'delivered':
          showIrisToast(context, '에이전트에게 보냈습니다');
          Navigator.of(context).pop(!allow);
        case 'already-answered' || 'expired':
          setState(() => _gone = result.result);
        default:
          showIrisToast(
            context,
            requestAnswerResultText(result.result),
            tone: IrisToastTone.error,
          );
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
    final variant = _variantOf(_body.tool);
    final gone = _gone ?? (_busy ? null : widget.closedAs);
    if (gone != null) return _answered(context, variant, gone);
    final request = widget.request;
    final ago = responseAgo(request.createdAt);
    final input = visibleControlCharacters(_body.input);
    final denyHint = switch (variant) {
      _Variant.command => '실행하지 않고 대화로 다시 지시합니다',
      _Variant.edit => '수정하지 않고 대화로 다시 지시합니다',
      _Variant.tool => '이 호출을 막고 대화로 다시 지시합니다',
    };
    final allowHint = switch (variant) {
      _Variant.command => '이번 한 번 실행합니다',
      _Variant.edit => '이번 수정만 적용합니다',
      _Variant.tool => '이번 호출만 허용합니다',
    };
    final approval = variant != _Variant.tool;
    final children = <Widget>[
      switch (variant) {
        _Variant.command => ResponseWhoRow(
          name: '명령 실행 승인',
          meta: '${widget.space} · $ago',
          icon: 'terminal-window',
        ),
        _Variant.edit => ResponseWhoRow(
          name: '파일 수정 승인',
          meta: '${widget.agentName} · ${widget.space} · $ago',
          icon: 'pencil-simple',
        ),
        _Variant.tool => ResponseKindRow(
          label: _body.tool.startsWith('mcp__') ? 'MCP 도구 승인' : '도구 사용 승인',
          tone: ResponseTone.approval,
          icon: 'squares-four',
          time: ago,
        ),
      },
      ResponseTitle(key: const Key('permission-title'), switch (variant) {
        _Variant.command => '이 명령을 실행할까요?',
        _Variant.edit => '이 파일을 수정할까요?',
        _Variant.tool => '이 도구 호출을 허용할까요?',
      }, approval: approval),
      ..._payload(context, variant, input),
      ResponseSectionLabel('답 고르기', approval: approval),
      ResponseOption(
        key: const Key('permission-option-1'),
        title: '허용',
        description: allowHint,
        approval: approval,
        selected: _choice == 0,
        onTap: _busy ? null : () => _pick(0),
      ),
      const SizedBox(height: 8),
      ResponseOption(
        key: const Key('permission-option-2'),
        title: '거절',
        description: denyHint,
        negative: true,
        approval: approval,
        selected: _choice == 1,
        onTap: _busy ? null : () => _pick(1),
      ),
    ];
    final label = _busy
        ? '보내는 중…'
        : (_choice == null
              ? '답을 고르세요'
              : (_choice == 0 ? '‘허용’ 보내기' : '‘거절’ 보내기'));
    return ResponseFrame(
      header: switch (variant) {
        _Variant.command => ResponseHeader.titledUpDown,
        _Variant.edit => ResponseHeader.plainUpDown,
        _Variant.tool => ResponseHeader.titledNext,
      },
      title: widget.agentName,
      space: widget.space,
      agentKind: widget.agentKind,
      nav: widget.nav,
      bodyPadding: approval
          ? const EdgeInsets.fromLTRB(20, 4, 20, 28)
          : const EdgeInsets.fromLTRB(16, 4, 16, 28),
      bar: IrisActionBar(
        buttons: [
          IrisButton(
            key: const Key('permission-later'),
            label: '나중에',
            tone: IrisButtonTone.ghost,
            onPressed: _busy ? null : () => Navigator.of(context).maybePop(),
          ),
          IrisButton(
            key: const Key('permission-send'),
            label: label,
            tone: IrisButtonTone.primary,
            onPressed: _choice == null || _busy
                ? null
                : () => _answer(_choice == 0),
          ),
        ],
      ),
      children: children,
    );
  }

  List<Widget> _payload(BuildContext context, _Variant variant, String input) {
    final description = _body.description;
    switch (variant) {
      case _Variant.command:
        return [
          ResponseCodeBox(key: const Key('permission-command'), text: input),
          if (description.isNotEmpty)
            ResponseContextRow(
              key: const Key('permission-description'),
              icon: 'list-bullets',
              label: '설명',
              value: description,
              first: true,
            ),
        ];
      case _Variant.edit:
        // 줄바꿈을 살려 줄마다 제어 문자를 보이게 바꾼 뒤 해석
        final diff = parseDiff(
          _body.input.split('\n').map(visibleControlCharacters).join('\n'),
        );
        return [
          if (diff != null)
            ResponseDiff(diff, fallbackName: _body.tool)
          else
            ResponseCodeBox(
              key: const Key('permission-command'),
              text: input,
              prompt: null,
              fontSize: 13.5,
            ),
          if (description.isNotEmpty)
            ResponseContextRow(
              key: const Key('permission-description'),
              icon: 'list-bullets',
              label: '설명',
              value: description,
              first: true,
            ),
        ];
      case _Variant.tool:
        final (server, tool) = _splitTool(_body.tool);
        return [
          if (description.isNotEmpty)
            Text(description, style: responseLeadStyle(context)),
          ResponseFacts([
            if (server != null) ('서버', server),
            ('도구', tool),
            if (input.isNotEmpty) ('입력', input),
          ]),
        ];
    }
  }

  Widget _answered(BuildContext context, _Variant variant, String gone) {
    final remaining = gone.startsWith('gone')
        ? (widget.nav?.count ?? 0)
        : ((widget.nav?.count ?? 1) - 1).clamp(0, 99);
    return ResponseFrame(
      header: ResponseHeader.titledNext,
      title: widget.agentName,
      space: widget.space,
      agentKind: widget.agentKind,
      bar: responseAnsweredBar(
        onHome: () => Navigator.of(context).pop(false),
        remaining: remaining,
        onNext: widget.nav?.onNext,
      ),
      children: [
        ResponseAnswered(
          title: responseGoneText(gone).$1,
          detail: responseGoneText(gone).$2,
          badge: responseGoneBadge(gone),
          kindLabel: switch (variant) {
            _Variant.command => '명령 실행 승인',
            _Variant.edit => '파일 수정 승인',
            _Variant.tool => '도구 사용 승인',
          },
          kindIcon: switch (variant) {
            _Variant.command => 'terminal-window',
            _Variant.edit => 'pencil-simple',
            _Variant.tool => 'squares-four',
          },
          ghost: responseGhostCode(
            context,
            visibleControlCharacters(_body.input),
            prompt: variant == _Variant.command ? r'$' : null,
          ),
        ),
      ],
    );
  }
}
