import 'package:flutter/material.dart';
import 'package:iris_remote/design/motion.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/screens/human_turn_screen.dart';
import 'package:iris_remote/screens/permission_request_screen.dart';
import 'package:iris_remote/screens/question_request_screen.dart';
import 'package:iris_remote/screens/response_kit.dart';
import 'package:iris_remote/state/remote_state.dart';

// 응답 화면 전체 화면 경로. 대기 중인 요청 사이를 위아래로 이동
// 반환값은 거절로 끝난 마지막 응답의 에이전트(홈이 그 대화 입력을 이어 열기 위함), 아니면 null
Future<String?> showResponseHost({
  required BuildContext context,
  required RemoteState state,
  required RemoteRequest request,
  required String agentName,
  required String agentKind,
  required String space,
}) async {
  final outcome = ResponseOutcome();
  final denied = await Navigator.of(context).push<bool>(
    MaterialPageRoute(
      builder: (_) => ResponseHost(
        outcome: outcome,
        state: state,
        request: request,
        agentName: agentName,
        agentKind: agentKind,
        space: space,
      ),
    ),
  );
  return denied == true ? outcome.deniedAgent : null;
}

// 호스트가 마지막으로 응답한 요청의 결과
class ResponseOutcome {
  String? deniedAgent;
}

bool _isResponse(RemoteRequest request) =>
    request.body is PermissionRequestBody ||
    request.body is QuestionRequestBody ||
    request.body is BrowserUserRequestBody;

class ResponseHost extends StatefulWidget {
  const ResponseHost({
    required this.state,
    required this.request,
    required this.agentName,
    required this.agentKind,
    required this.space,
    this.outcome,
    super.key,
  });

  final ResponseOutcome? outcome;
  final RemoteState state;
  final RemoteRequest request;
  final String agentName;
  final String agentKind;
  final String space;

  @override
  State<ResponseHost> createState() => _ResponseHostState();
}

class _ResponseHostState extends State<ResponseHost> {
  late RemoteRequest _current = widget.request;
  final _seen = <String>{};
  // 요청별 초안. 위젯 상태가 요청마다 새로 만들어져도 선택·입력을 보존
  final _questionDrafts = <String, QuestionDraft>{};
  final _permissionChoices = <String, int>{};
  final _humanChoices = <String, String>{};

  @override
  void dispose() {
    for (final draft in _questionDrafts.values) {
      draft.dispose();
    }
    super.dispose();
  }

  void _go(RemoteRequest request) => setState(() => _current = request);

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.state,
      builder: (context, _) {
        final state = widget.state;
        final list = state.requests.where(_isResponse).toList();
        final index = list.indexWhere((item) => item.ref == _current.ref);
        if (index >= 0) {
          _current = list[index];
          _seen.add(_current.ref);
        }
        // 화면을 연 뒤 목록에서 사라진 요청: 답했거나 만료·취소된 것
        final gone = index < 0 && _seen.contains(_current.ref);
        // 서버 목록은 사라진 이유를 알리지 않아 만료 시각으로만 구분
        final closedAs = !gone
            ? null
            : (DateTime.now().millisecondsSinceEpoch >= _current.expiresAt
                  ? 'gone-expired'
                  : 'gone');
        final others = list.where((item) => item.ref != _current.ref).toList();
        final nav = gone
            ? ResponseNav(
                index: 0,
                count: others.length,
                onNext: others.isEmpty ? null : () => _go(others.first),
              )
            : ResponseNav(
                index: index < 0 ? 0 : index,
                count: list.isEmpty ? 1 : list.length,
                onPrev: index > 0 ? () => _go(list[index - 1]) : null,
                onNext: index >= 0 && index < list.length - 1
                    ? () => _go(list[index + 1])
                    : null,
              );
        final request = _current;
        final agent = state.agent(request.agent);
        final name = agent?.name ?? widget.agentName;
        final kind = agent?.kind ?? widget.agentKind;
        final space = agent?.space ?? widget.space;
        final body = request.body;
        final screen = switch (body) {
          PermissionRequestBody() => PermissionRequestSheet(
            key: ValueKey(request.ref),
            request: request,
            agentName: name,
            agentKind: kind,
            space: space,
            nav: nav,
            closedAs: closedAs,
            initialChoice: _permissionChoices[request.ref],
            onChoice: (choice) => _permissionChoices[request.ref] = choice,
            onAnswer: (allow) async {
              final result = await state.answerPermission(
                request,
                allow: allow,
              );
              if (result.result == 'delivered') {
                widget.outcome?.deniedAgent = allow ? null : request.agent;
              }
              return result;
            },
          ),
          QuestionRequestBody() => QuestionRequestSheet(
            key: ValueKey(request.ref),
            request: request,
            agentName: name,
            agentKind: kind,
            space: space,
            nav: nav,
            closedAs: closedAs,
            draft: _questionDrafts.putIfAbsent(
              request.ref,
              () => QuestionDraft(body.questions.length),
            ),
            onAnswer: (responses) =>
                state.answerQuestions(request, body, responses),
          ),
          BrowserUserRequestBody() => HumanTurnSheet(
            key: ValueKey(request.ref),
            state: state,
            request: request,
            agent:
                agent ??
                RemoteAgent(
                  ref: request.agent,
                  name: name,
                  kind: kind,
                  status: 'blocked',
                  question: false,
                  space: space,
                  spaceRef: '',
                  spaceOrder: 0,
                  sessionOrder: 0,
                  parent: null,
                  lastActivityAt: null,
                  can: const AgentPermissions(stop: false, message: false),
                ),
            onOpenTab: () {},
            nav: nav,
            closedAs: closedAs,
            initialChoice: _humanChoices[request.ref],
            onChoice: (choice) => _humanChoices[request.ref] = choice,
          ),
        };
        // 요청 이동: 새 화면만 페이드 + 8px 슬라이드, 이전 화면은 바로 제거
        final background = context.iris.background;
        return AnimatedSwitcher(
          duration: irisSwapDuration,
          switchInCurve: irisEase,
          transitionBuilder: (child, animation) => FadeTransition(
            opacity: animation,
            child: AnimatedBuilder(
              animation: animation,
              builder: (context, child) => Transform.translate(
                offset: Offset(0, irisSlideOffset * (1 - animation.value)),
                child: child,
              ),
              child: child,
            ),
          ),
          layoutBuilder: (current, previous) => Stack(
            fit: StackFit.expand,
            children: [
              ColoredBox(color: background),
              ?current,
            ],
          ),
          child: screen,
        );
      },
    );
  }
}
