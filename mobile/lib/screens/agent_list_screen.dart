import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:iris_remote/design/agent_tile.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/command_text.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:iris_remote/design/bottom_nav.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/motion.dart';
import 'package:iris_remote/design/sheet.dart';
import 'package:iris_remote/design/status_chip.dart';
import 'package:iris_remote/design/toast.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/format/control_characters.dart';
import 'package:iris_remote/format/result_text.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/agent_screen.dart';
import 'package:iris_remote/screens/terminal_question_screen.dart';
import 'package:iris_remote/screens/terminal_screen.dart';
import 'package:iris_remote/screens/terminal_question_card.dart';
import 'package:iris_remote/design/browser_groups.dart';
import 'package:iris_remote/screens/browser_screen.dart';
import 'package:iris_remote/screens/human_turn_screen.dart';
import 'package:iris_remote/screens/permission_request_screen.dart';
import 'package:iris_remote/screens/question_request_screen.dart';
import 'package:iris_remote/state/remote_state.dart';

class AgentListScreen extends StatelessWidget {
  const AgentListScreen({
    required this.state,
    required this.onDisconnect,
    required this.onUnregister,
    this.responseFocus = 0,
    super.key,
  });

  final int responseFocus;
  final RemoteState state;
  final VoidCallback onDisconnect;
  final VoidCallback onUnregister;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: state,
      builder: (context, _) => AgentHomeView(
        responseFocus: responseFocus,
        agents: state.agents
            .where(
              (agent) =>
                  agent.kind != 'terminal' || state.supports('terminal.watch'),
            )
            .toList(),
        requests: state.requests,
        promptSession: state.supports('terminal.select') ? state.session : null,
        terminalQuestions:
            state.supports('terminal.watch') && state.supports('terminal.key')
            ? state.terminalQuestions
            : const [],
        onRefresh: state.refreshSessions,
        onOpenWaitingTerminal: state.supports('terminal.watch')
            ? (agent) => Navigator.of(context).push<void>(
                MaterialPageRoute(
                  builder: (_) =>
                      TerminalScreen(state: state, agentRef: agent.ref),
                ),
              )
            : null,
        onOpenTerminalQuestion: (request) => Navigator.of(context).push<void>(
          MaterialPageRoute(
            builder: (_) =>
                TerminalScreen(state: state, agentRef: request.agent),
          ),
        ),
        onAnswerTerminalQuestion: (request, agent) => showTerminalQuestion(
          context: context,
          state: state,
          agent: agent,
          onTerminal: () => Navigator.of(context).push<void>(
            MaterialPageRoute(
              builder: (_) =>
                  TerminalScreen(state: state, agentRef: request.agent),
            ),
          ),
          onChat: () => Navigator.of(context).push<void>(
            MaterialPageRoute(
              builder: (_) => AgentScreen(state: state, agentRef: agent.ref),
            ),
          ),
        ),
        connectionName: state.macName,
        browserSpaces: state.browserSpaces,
        browserTabs: state.browserTabs,
        browserTabGroups: state.browserTabGroups,
        onOpenAgent: (agent) => Navigator.of(context).push<void>(
          MaterialPageRoute(
            builder: (_) => agent.kind == 'terminal'
                ? TerminalScreen(state: state, agentRef: agent.ref)
                : AgentScreen(state: state, agentRef: agent.ref),
          ),
        ),
        onAnswerPermission: (request, allow) =>
            state.answerPermission(request, allow: allow),
        onAnswerQuestion: (request, body, responses) =>
            state.answerQuestions(request, body, responses),
        onOpenRequest: (request, agent) async {
          final body = request.body;
          final String? deniedAgent;
          if (body is PermissionRequestBody) {
            deniedAgent = await showPermissionRequestSheet(
              context: context,
              request: request,
              state: state,
              agentName: agent.name,
              agentKind: agent.kind,
              space: agent.space,
            );
          } else if (body is QuestionRequestBody) {
            deniedAgent = await showQuestionRequestSheet(
              context: context,
              request: request,
              state: state,
              agentName: agent.name,
              agentKind: agent.kind,
              space: agent.space,
            );
          } else if (body is BrowserUserRequestBody) {
            deniedAgent = await showHumanTurnSheet(
              context: context,
              state: state,
              request: request,
              agent: agent,
              onOpenTab: () => _openHumanTab(context, request, agent),
            );
          } else {
            deniedAgent = null;
          }
          // 이동한 요청에서 거절했으면 처음 연 요청이 아니라 그 에이전트의 대화로 이어감
          if (deniedAgent != null && context.mounted) {
            await Navigator.of(context).push<void>(
              MaterialPageRoute(
                builder: (_) => AgentScreen(
                  state: state,
                  agentRef: deniedAgent!,
                  focusComposer: true,
                ),
              ),
            );
          }
        },
        onOpenBrowserTab: (tab) => _openBrowserTab(context, tab),
        onOpenBrowserGroupTab: (tab, agent) =>
            _openBrowserTab(context, tab, agent: agent),
        onAnswerHuman: (request, choice) =>
            state.answerBrowserUser(request, choice: choice),
        onSettings: () => _showSettings(context),
      ),
    );
  }

  Future<void> _openBrowserTab(
    BuildContext context,
    BrowserTab tab, {
    RemoteRequest? request,
    RemoteAgent? agent,
  }) async {
    final target = agent ?? _agentForTab(tab);
    final added = await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(
        builder: (_) => BrowserScreen(
          state: state,
          agentRef: target?.ref ?? '',
          tabRef: tab.ref,
          humanRequest: request,
        ),
      ),
    );
    if (added == true && target != null && context.mounted) {
      await Navigator.of(context).push<void>(
        MaterialPageRoute(
          builder: (_) => AgentScreen(
            state: state,
            agentRef: target.ref,
            focusComposer: true,
          ),
        ),
      );
    }
  }

  void _openHumanTab(
    BuildContext context,
    RemoteRequest request,
    RemoteAgent agent,
  ) {
    final body = request.body as BrowserUserRequestBody;
    final tab = body.tab == null ? null : state.browserTab(body.tab!);
    if (tab == null) return;
    Navigator.of(context).pop();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (context.mounted) {
        _openBrowserTab(context, tab, request: request, agent: agent);
      }
    });
  }

  RemoteAgent? _agentForTab(BrowserTab tab) {
    for (final agent in state.agents) {
      if (tab.sessions.contains(agent.ref) && agent.spaceRef == tab.space) {
        return agent;
      }
    }
    return state.agents
        .where(
          (agent) =>
              (agent.spaceRef == tab.space ||
                  state.browserSpace(tab.space)?.name == agent.space) &&
              agent.kind != 'terminal',
        )
        .firstOrNull;
  }

  Future<void> _showSettings(BuildContext context) async {
    await showIrisSheet<void>(
      context: context,
      builder: (sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const IrisSheetGrabber(),
          const SizedBox(height: 18),
          Align(
            alignment: Alignment.centerLeft,
            child: Text(
              '연결 설정',
              style: TextStyle(
                color: context.iris.foreground,
                fontSize: 21,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              IrisButton(
                label: '연결 끊기',
                onPressed: () {
                  Navigator.of(sheetContext).pop();
                  onDisconnect();
                },
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              IrisButton(
                label: '이 폰 등록 해제',
                tone: IrisButtonTone.danger,
                onPressed: () {
                  Navigator.of(sheetContext).pop();
                  onUnregister();
                },
              ),
            ],
          ),
        ],
      ),
    );
  }
}

typedef PermissionAnswer = Future<RequestAnswerResult> Function(
  RemoteRequest request,
  bool allow,
);
typedef QuestionAnswer = Future<RequestAnswerResult> Function(
  RemoteRequest request,
  QuestionRequestBody body,
  List<QuestionResponse> responses,
);
typedef HumanAnswer = Future<RequestAnswerResult> Function(
  RemoteRequest request,
  String choice,
);

enum _HomeSort { iris, recent }

class AgentHomeView extends StatefulWidget {
  const AgentHomeView({
    required this.agents,
    required this.requests,
    required this.connectionName,
    this.responseFocus = 0,
    this.terminalQuestions = const [],
    this.onAnswerTerminalQuestion,
    this.promptSession,
    this.onOpenTerminalQuestion,
    this.onOpenWaitingTerminal,
    this.onRefresh,
    this.browserSpaces = const [],
    this.browserTabs = const [],
    this.browserTabGroups = const [],
    required this.onOpenAgent,
    required this.onAnswerPermission,
    required this.onAnswerQuestion,
    required this.onOpenRequest,
    this.onOpenBrowserTab,
    this.onOpenBrowserGroupTab,
    this.onAnswerHuman,
    required this.onSettings,
    super.key,
  });

  final int responseFocus;
  final List<RemoteAgent> agents;
  final List<RemoteRequest> requests;
  final ActiveRemoteSession? promptSession;
  final List<RemoteRequest> terminalQuestions;
  // 터미널 질문을 전체 화면으로 열기
  final void Function(RemoteRequest request, RemoteAgent agent)?
  onAnswerTerminalQuestion;
  final ValueChanged<RemoteRequest>? onOpenTerminalQuestion;
  final ValueChanged<RemoteAgent>? onOpenWaitingTerminal;
  final Future<void> Function()? onRefresh;
  final String connectionName;
  final List<BrowserSpace> browserSpaces;
  final List<BrowserTab> browserTabs;
  final List<BrowserTabGroupInfo> browserTabGroups;
  final ValueChanged<RemoteAgent> onOpenAgent;
  final PermissionAnswer onAnswerPermission;
  final QuestionAnswer onAnswerQuestion;
  final Future<void> Function(RemoteRequest request, RemoteAgent agent)
  onOpenRequest;
  final ValueChanged<BrowserTab>? onOpenBrowserTab;
  final void Function(BrowserTab tab, RemoteAgent? agent)?
  onOpenBrowserGroupTab;
  final HumanAnswer? onAnswerHuman;
  final VoidCallback onSettings;

  @override
  State<AgentHomeView> createState() => _AgentHomeViewState();
}

class _AgentHomeViewState extends State<AgentHomeView> {
  final ScrollController _scroll = ScrollController();

  @override
  void didUpdateWidget(AgentHomeView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.responseFocus != widget.responseFocus && _scroll.hasClients) {
      _scroll.jumpTo(0);
    }
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  final Set<String> _resolved = {};
  // 입장 모션을 이미 낸(또는 첫 빌드에 있던) 질문 카드 id
  final Set<String> _enteredCards = {};
  bool _cardsSeeded = false;
  final Set<String> _collapsedSpaces = {};
  _HomeSort _sort = _HomeSort.iris;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final pending = widget.requests
        .where(
          (request) =>
              !_resolved.contains(request.ref) &&
              _agent(request.agent)?.kind != 'terminal',
        )
        .toList(growable: false);
    final terminalCards = widget.onOpenTerminalQuestion == null
        ? const <(RemoteRequest, RemoteAgent)>[]
        : [
            for (final question in widget.terminalQuestions)
              if (_agent(question.agent) case final agent?) (question, agent),
          ];
    final waiting = widget.onOpenWaitingTerminal == null
        ? const <RemoteAgent>[]
        : widget.agents
              .where(
                (a) =>
                    (a.status == 'blocked' || a.question) &&
                    !widget.requests.any((r) => r.agent == a.ref) &&
                    !widget.terminalQuestions.any((r) => r.agent == a.ref),
              )
              .toList(growable: false);
    final questionCount =
        pending.length + terminalCards.length + waiting.length;
    if (!_cardsSeeded) {
      _cardsSeeded = true;
      _enteredCards.addAll([
        for (final (request, _) in terminalCards) request.ref,
        for (final agent in waiting) 'waiting-${agent.ref}',
        for (final request in pending) request.ref,
      ]);
    }
    final spaces = _agentSpaces(widget.agents);
    final recent = [...widget.agents]..sort(_compareRecent);
    final bottom = MediaQuery.paddingOf(context).bottom;

    return Scaffold(
      body: Stack(
        children: [
          SafeArea(
            bottom: false,
            child: ListView(
              key: const Key('home-scroll'),
              controller: _scroll,
              padding: EdgeInsets.only(bottom: 24 + bottom),
              children: [
                _HomeHeader(
                  name: widget.connectionName,
                  spaceCount: spaces.length,
                  sessionCount: widget.agents.length,
                  onSettings: widget.onSettings,
                ),
                AnimatedSize(
                  duration: const Duration(milliseconds: 320),
                  curve: irisEase,
                  alignment: Alignment.topCenter,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _QuestionHeader(count: questionCount),
                      if (questionCount == 0)
                        _QuestionEmpty(
                          onTerminal: _openTerminal,
                          onBrowser: _openBrowser,
                        )
                      else
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          child: Column(
                            children: [
                              for (final (request, agent) in terminalCards)
                                Padding(
                                  padding: const EdgeInsets.only(bottom: 10),
                                  child: IrisEnterOnce(
                                    key: ValueKey('enter-${request.ref}'),
                                    registry: _enteredCards,
                                    id: request.ref,
                                    child: TerminalQuestionCard(
                                      key: ValueKey(request.ref),
                                      request: request,
                                      session: widget.promptSession,
                                      agentName: agent.name,
                                      onOpen: () =>
                                          widget.onOpenTerminalQuestion!(
                                            request,
                                          ),
                                      onChat: () => widget.onOpenAgent(agent),
                                      onAnswer:
                                          widget.onAnswerTerminalQuestion ==
                                              null
                                          ? null
                                          : () =>
                                                widget
                                                    .onAnswerTerminalQuestion!(
                                                  request,
                                                  agent,
                                                ),
                                    ),
                                  ),
                                ),
                              for (final agent in waiting)
                                Padding(
                                  padding: const EdgeInsets.only(bottom: 10),
                                  child: IrisEnterOnce(
                                    key: ValueKey('enter-waiting-${agent.ref}'),
                                    registry: _enteredCards,
                                    id: 'waiting-${agent.ref}',
                                    child: _WaitingTerminalCard(
                                      agent: agent,
                                      // 질문형 끝맺음은 대화창에서 답하고, 터미널 대기만 터미널로 이동
                                      onOpen: agent.question
                                          ? () => widget.onOpenAgent(agent)
                                          : () => widget.onOpenWaitingTerminal!(
                                              agent,
                                            ),
                                    ),
                                  ),
                                ),
                              for (final request in pending)
                                if (_agent(request.agent) case final agent?)
                                  Padding(
                                    padding: const EdgeInsets.only(bottom: 10),
                                    child: IrisEnterOnce(
                                      key: ValueKey('enter-${request.ref}'),
                                      registry: _enteredCards,
                                      id: request.ref,
                                      child: _RequestCard(
                                        key: ValueKey(request.ref),
                                        request: request,
                                        agent: agent,
                                        onOpen: () => widget.onOpenRequest(
                                          request,
                                          agent,
                                        ),
                                        onPermission: (allow) =>
                                            _answerPermission(request, allow),
                                        onQuestion: (responses) =>
                                            _answerQuestion(request, responses),
                                        onHuman: widget.onAnswerHuman == null
                                            ? null
                                            : (choice) =>
                                                  _answerHuman(request, choice),
                                      ),
                                    ),
                                  ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
                _SessionsHeader(
                  count: widget.agents.length,
                  sortedByRecent: _sort == _HomeSort.recent,
                  onSort: _showSortOptions,
                  onRefresh: widget.onRefresh == null ? null : _refresh,
                ),
                if (widget.agents.isEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 40, 20, 0),
                    child: Text(
                      '열려 있는 세션이 없습니다.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: colors.muted, fontSize: 15),
                    ),
                  )
                else if (_sort == _HomeSort.iris)
                  for (final (index, space) in spaces.indexed)
                    _SpaceCard(
                      headerKey: Key('home-space-${space.ref}'),
                      label: space.label,
                      color: _spaceColor(colors, index),
                      count: space.nodes.length,
                      expanded: !_collapsedSpaces.contains(space.ref),
                      onToggle: () => _toggle(space.ref),
                      children: [
                        for (final node in space.nodes)
                          _AgentRow(
                            agent: node.agent,
                            depth: node.depth,
                            request: _requestFor(pending, node.agent),
                            onTap: () => widget.onOpenAgent(node.agent),
                            onOpenRequest: _openRequest,
                            onOpenWaiting: widget.onOpenWaitingTerminal,
                          ),
                      ],
                    )
                else
                  _SpaceCard(
                    headerKey: const Key('home-recent-header'),
                    label: '최근 활동순',
                    color: colors.muted,
                    count: recent.length,
                    expanded: !_collapsedSpaces.contains('recent'),
                    onToggle: () => _toggle('recent'),
                    children: [
                      for (final agent in recent)
                        _AgentRow(
                          agent: agent,
                          showSpace: true,
                          request: _requestFor(pending, agent),
                          onTap: () => widget.onOpenAgent(agent),
                          onOpenRequest: _openRequest,
                          onOpenWaiting: widget.onOpenWaitingTerminal,
                        ),
                    ],
                  ),
                if (widget.browserTabs.isNotEmpty &&
                    widget.onOpenBrowserTab != null) ...[
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
                    child: _SectionTitle(
                      key: const Key('home-browser-header'),
                      label: '브라우저 탭',
                      count: widget.browserTabs.length,
                    ),
                  ),
                  for (final (index, group) in browserGroups(
                    widget.browserSpaces,
                    widget.browserTabs,
                    widget.agents,
                  ).indexed)
                    _SpaceCard(
                      label: '${group.space.name} · ${group.name}',
                      color: _spaceColor(colors, index),
                      count: group.tabs.length,
                      expanded: true,
                      children: [
                        for (final tab in group.tabs)
                          _BrowserRow(
                            tab: tab,
                            space: group.space.name,
                            group: widget.browserTabGroups
                                .where((item) => item.ref == tab.group)
                                .firstOrNull,
                            onTap: () => _openTab(tab, group.agent),
                          ),
                      ],
                    ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  RemoteAgent? _agent(String ref) {
    for (final agent in widget.agents) {
      if (agent.ref == ref) return agent;
    }
    return null;
  }

  RemoteRequest? _requestFor(List<RemoteRequest> pending, RemoteAgent agent) =>
      pending.where((request) => request.agent == agent.ref).firstOrNull;

  void _toggle(String key) => setState(() {
    if (!_collapsedSpaces.add(key)) _collapsedSpaces.remove(key);
  });

  void _openRequest(RemoteRequest request, RemoteAgent agent) =>
      unawaited(widget.onOpenRequest(request, agent));

  Future<void> _refresh() async {
    try {
      await widget.onRefresh!();
    } catch (_) {
      if (mounted) {
        showIrisToast(
          context,
          '새로고침하지 못했습니다. 다시 시도하세요.',
          tone: IrisToastTone.error,
        );
      }
    }
  }

  // 첫 터미널 세션 화면. 없으면 안내
  void _openTerminal() {
    final terminal = widget.agents
        .where((agent) => agent.kind == 'terminal')
        .firstOrNull;
    if (terminal == null) {
      showIrisToast(context, '열린 터미널이 없습니다.', tone: IrisToastTone.error);
      return;
    }
    widget.onOpenAgent(terminal);
  }

  // 홈 목록 첫 브라우저 탭 화면. 없으면 안내
  void _openBrowser() {
    final group = widget.onOpenBrowserTab == null
        ? null
        : browserGroups(
            widget.browserSpaces,
            widget.browserTabs,
            widget.agents,
          ).where((group) => group.tabs.isNotEmpty).firstOrNull;
    if (group == null) {
      showIrisToast(context, '열린 브라우저 탭이 없습니다.', tone: IrisToastTone.error);
      return;
    }
    _openTab(group.tabs.first, group.agent);
  }

  void _openTab(BrowserTab tab, RemoteAgent? agent) =>
      widget.onOpenBrowserGroupTab != null
      ? widget.onOpenBrowserGroupTab!(tab, agent)
      : widget.onOpenBrowserTab!(tab);

  Future<void> _showSortOptions() async {
    await showIrisSheet<void>(
      context: context,
      builder: (sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const IrisSheetGrabber(),
          const SizedBox(height: 18),
          Text(
            '세션 정렬',
            style: TextStyle(
              color: context.iris.foreground,
              fontSize: 21,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 16),
          IrisButton(
            key: const Key('home-sort-iris'),
            label: 'Iris 순서',
            icon: 'stack',
            tone: _sort == _HomeSort.iris
                ? IrisButtonTone.primary
                : IrisButtonTone.secondary,
            width: double.infinity,
            expand: false,
            onPressed: () => _chooseSort(sheetContext, _HomeSort.iris),
          ),
          const SizedBox(height: 8),
          IrisButton(
            key: const Key('home-sort-recent'),
            label: '최근 활동순',
            icon: 'clock',
            tone: _sort == _HomeSort.recent
                ? IrisButtonTone.primary
                : IrisButtonTone.secondary,
            width: double.infinity,
            expand: false,
            onPressed: () => _chooseSort(sheetContext, _HomeSort.recent),
          ),
        ],
      ),
    );
  }

  void _chooseSort(BuildContext sheetContext, _HomeSort value) {
    Navigator.of(sheetContext).pop();
    if (_sort != value) setState(() => _sort = value);
  }

  Future<String> _answerPermission(RemoteRequest request, bool allow) async {
    try {
      final result = await widget.onAnswerPermission(request, allow);
      _acceptResult(request.ref, result.result);
      return requestAnswerResultText(result.result);
    } on RemoteFailure catch (error) {
      return error.message;
    }
  }

  Future<String> _answerQuestion(
    RemoteRequest request,
    List<QuestionResponse> responses,
  ) async {
    try {
      final body = request.body as QuestionRequestBody;
      final result = await widget.onAnswerQuestion(request, body, responses);
      _acceptResult(request.ref, result.result);
      return requestAnswerResultText(result.result);
    } on ProtocolException catch (error) {
      return error.message;
    } on RemoteFailure catch (error) {
      return error.message;
    }
  }

  Future<String> _answerHuman(RemoteRequest request, String choice) async {
    try {
      final result = await widget.onAnswerHuman!(request, choice);
      _acceptResult(request.ref, result.result);
      return requestAnswerResultText(result.result);
    } on RemoteFailure catch (error) {
      return error.message;
    }
  }

  void _acceptResult(String ref, String result) {
    if (!mounted) return;
    if (result == 'delivered' ||
        result == 'already-answered' ||
        result == 'expired') {
      setState(() => _resolved.add(ref));
    }
  }
}

// 스페이스 점 색. 스페이스 순서대로 돌려 쓴다
Color _spaceColor(IrisColors colors, int index) => [
  colors.sky,
  colors.lime,
  colors.teal,
  colors.mint,
  colors.yellow,
][index % 5];

// 머리글. 컴퓨터 이름 22/700 + 실시간 칩, 아래 보조 줄, 오른쪽 설정
class _HomeHeader extends StatelessWidget {
  const _HomeHeader({
    required this.name,
    required this.spaceCount,
    required this.sessionCount,
    required this.onSettings,
  });

  final String name;
  final int spaceCount;
  final int sessionCount;
  final VoidCallback onSettings;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Container(
      key: const Key('home-header'),
      constraints: const BoxConstraints(minHeight: 64),
      padding: const EdgeInsets.fromLTRB(20, 6, 6, 6),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        name,
                        key: const Key('home-title'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: colors.foreground,
                          fontSize: 22,
                          fontWeight: FontWeight.w700,
                          letterSpacing: -0.44,
                          height: 1.2,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    const IrisStatusChip(IrisStatus.live),
                  ],
                ),
                const SizedBox(height: 3),
                Text(
                  key: const Key('home-connection'),
                  '스페이스 $spaceCount · 세션 $sessionCount',
                  style: TextStyle(color: colors.muted, fontSize: 12.5),
                ),
              ],
            ),
          ),
          _IconAction(
            key: const Key('home-settings'),
            tooltip: '설정',
            shapes: irisSlidersShapes,
            onPressed: onSettings,
          ),
        ],
      ),
    );
  }
}

// 44x44 투명 아이콘 버튼
class _IconAction extends StatelessWidget {
  const _IconAction({
    required this.tooltip,
    required this.onPressed,
    this.icon,
    this.shapes,
    super.key,
  });

  final String tooltip;
  final VoidCallback? onPressed;
  final String? icon;
  final String? shapes;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final color = colors.foreground2;
    return Semantics(
      button: true,
      label: tooltip,
      enabled: onPressed != null,
      onTap: onPressed,
      excludeSemantics: true,
      child: Opacity(
        opacity: onPressed == null ? .38 : 1,
        child: SizedBox.square(
          dimension: 44,
          child: TextButton(
            onPressed: onPressed,
            style: ButtonStyle(
              padding: const WidgetStatePropertyAll(EdgeInsets.zero),
              overlayColor: WidgetStateProperty.resolveWith(
                (states) => states.contains(WidgetState.pressed)
                    ? colors.tint2
                    : Colors.transparent,
              ),
              backgroundColor: const WidgetStatePropertyAll(Colors.transparent),
              shape: const WidgetStatePropertyAll(CircleBorder()),
            ),
            child: shapes != null
                ? SvgPicture.string(
                    irisNavSvg(shapes!, color),
                    width: 22,
                    height: 22,
                  )
                : IrisIcon(icon!, size: 20, color: color),
          ),
        ),
      ),
    );
  }
}

// 질문 구역 머리글. 건수는 있으면 분홍 배지, 없으면 숫자만
class _QuestionHeader extends StatelessWidget {
  const _QuestionHeader({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final mono = TextStyle(
      fontFamily: 'monospace',
      fontWeight: FontWeight.w500,
      color: colors.foreground2,
    );
    return Container(
      key: const Key('home-needed-header'),
      height: 40,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      alignment: Alignment.centerLeft,
      child: Row(
        children: [
          Text(
            '질문',
            style: TextStyle(
              color: colors.muted,
              fontSize: 13,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.26,
            ),
          ),
          const SizedBox(width: 8),
          IrisPulse(
            value: count,
            child: count == 0
                ? Text('0', style: mono.copyWith(fontSize: 13))
                : Container(
                    key: const Key('home-needed-count'),
                    constraints: const BoxConstraints(minWidth: 20),
                    height: 20,
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: colors.pink,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      '$count',
                      style: mono.copyWith(
                        color: colors.ink,
                        fontSize: 11.5,
                        fontWeight: FontWeight.w700,
                        height: 1,
                      ),
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}

// 질문이 없을 때. 점선 상자 + 터미널·브라우저 바로가기
class _QuestionEmpty extends StatelessWidget {
  const _QuestionEmpty({required this.onTerminal, required this.onBrowser});

  final VoidCallback onTerminal;
  final VoidCallback onBrowser;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Padding(
      key: const Key('home-empty'),
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
      child: CustomPaint(
        foregroundPainter: _DashedRRect(colors.line2, 16),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 24, 18, 18),
          child: Column(
            children: [
              Container(
                width: 56,
                height: 56,
                decoration: BoxDecoration(
                  color: colors.tint2,
                  shape: BoxShape.circle,
                ),
                alignment: Alignment.center,
                child: IrisIcon('check', size: 26, color: colors.link),
              ),
              const SizedBox(height: 12),
              Text(
                '질문이 없습니다',
                style: TextStyle(
                  color: colors.foreground,
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                '새 질문이 오면 알림으로 알려 줍니다.',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: colors.muted,
                  fontSize: 13.5,
                  height: 1.55,
                ),
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: _Tile(
                      key: const Key('home-tile-terminal'),
                      icon: 'terminal-window',
                      label: '터미널 열기',
                      onTap: onTerminal,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: _Tile(
                      key: const Key('home-tile-browser'),
                      icon: 'globe',
                      label: '브라우저 탭',
                      onTap: onBrowser,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({
    required this.icon,
    required this.label,
    required this.onTap,
    super.key,
  });

  final String icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Material(
      color: colors.level1,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: colors.separator),
      ),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 76),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              IrisIcon(icon, size: 22, color: colors.link),
              const SizedBox(height: 6),
              Text(
                label,
                style: TextStyle(
                  color: colors.foreground,
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DashedRRect extends CustomPainter {
  _DashedRRect(this.color, this.radius);

  final Color color;
  final double radius;

  @override
  void paint(Canvas canvas, Size size) {
    final path = Path()
      ..addRRect(
        RRect.fromRectAndRadius(
          Offset.zero & size,
          Radius.circular(radius),
        ).deflate(.5),
      );
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    for (final metric in path.computeMetrics()) {
      for (var at = 0.0; at < metric.length; at += 7) {
        canvas.drawPath(metric.extractPath(at, at + 4), paint);
      }
    }
  }

  @override
  bool shouldRepaint(_DashedRRect old) =>
      old.color != color || old.radius != radius;
}

// 세션 구역 머리글. 제목 15/600 + 건수, 오른쪽 정렬·새로고침
class _SessionsHeader extends StatelessWidget {
  const _SessionsHeader({
    required this.count,
    required this.sortedByRecent,
    required this.onSort,
    required this.onRefresh,
  });

  final int count;
  final bool sortedByRecent;
  final VoidCallback onSort;
  final VoidCallback? onRefresh;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 12, 6, 4),
      child: Row(
        children: [
          Expanded(
            child: _SectionTitle(label: '세션', count: count),
          ),
          _IconAction(
            key: const Key('home-sort'),
            tooltip: sortedByRecent ? '정렬: 최근 활동순' : '정렬: Iris 순서',
            icon: sortedByRecent ? 'clock' : 'stack',
            onPressed: onSort,
          ),
          if (onRefresh != null)
            _IconAction(
              key: const Key('home-refresh'),
              tooltip: '새로고침',
              icon: 'arrow-clockwise',
              onPressed: onRefresh,
            ),
        ],
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle({required this.label, required this.count, super.key});

  final String label;
  final int count;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Padding(
      padding: EdgeInsets.zero,
      child: Row(
        children: [
          Text(
            label,
            style: TextStyle(
              color: colors.foreground,
              fontSize: 15,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(width: 8),
          Text(
            '$count',
            style: TextStyle(
              color: colors.muted,
              fontSize: 15,
              fontWeight: FontWeight.w500,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ],
      ),
    );
  }
}

// 스페이스 묶음 카드. 머리글(색 점·이름·건수·접기) 아래에 줄을 모은다
class _SpaceCard extends StatelessWidget {
  const _SpaceCard({
    required this.label,
    required this.color,
    required this.count,
    required this.expanded,
    required this.children,
    this.onToggle,
    this.headerKey,
  });

  final String label;
  final Color color;
  final int count;
  final bool expanded;
  final VoidCallback? onToggle;
  final Key? headerKey;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final radius = BorderRadius.circular(16);
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: colors.level1,
        borderRadius: radius,
        border: Border.all(color: colors.separator),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            key: headerKey,
            onTap: onToggle,
            child: Container(
              height: 48,
              padding: const EdgeInsets.fromLTRB(16, 0, 4, 0),
              decoration: BoxDecoration(
                border: expanded && children.isNotEmpty
                    ? Border(bottom: BorderSide(color: colors.separator))
                    : null,
              ),
              child: Row(
                children: [
                  Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: color,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Row(
                      children: [
                        Flexible(
                          child: Text(
                            label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: colors.foreground,
                              fontSize: 14,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          '$count',
                          style: TextStyle(
                            color: colors.muted,
                            fontSize: 14,
                            fontWeight: FontWeight.w500,
                            fontFeatures: const [FontFeature.tabularFigures()],
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (onToggle != null)
                    SizedBox.square(
                      dimension: 44,
                      child: Center(
                        child: IrisIcon(
                          expanded ? 'caret-down' : 'caret-right',
                          size: 16,
                          color: colors.muted,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          if (expanded)
            for (final (index, child) in children.indexed)
              DecoratedBox(
                decoration: BoxDecoration(
                  border: index > 0
                      ? Border(top: BorderSide(color: colors.separator))
                      : null,
                ),
                child: child,
              ),
        ],
      ),
    );
  }
}

// 대기 중인 터미널. 질문 구역에 올라오는 카드
class _WaitingTerminalCard extends StatelessWidget {
  const _WaitingTerminalCard({required this.agent, required this.onOpen});

  final RemoteAgent agent;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Container(
      key: Key('waiting-${agent.ref}'),
      padding: const EdgeInsets.fromLTRB(14, 11, 12, 11),
      decoration: BoxDecoration(
        color: colors.level1,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: colors.separator),
      ),
      child: Row(
        children: [
          const IrisStatusGlyph(status: 'blocked', size: 16),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              '${agent.name} · 답 필요',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: colors.foreground2,
                fontSize: 13,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
          const SizedBox(width: 8),
          IrisButton(
            label: agent.question ? '대화창으로 이동' : '터미널에서 답하기',
            tone: IrisButtonTone.primary,
            height: 36,
            expand: false,
            onPressed: onOpen,
          ),
        ],
      ),
    );
  }
}

// 질문 카드. 윗줄(종류·시간) / 본문 / 아랫줄(세션·버튼). 카드를 누르면 상세
class _RequestCard extends StatefulWidget {
  const _RequestCard({
    required this.request,
    required this.agent,
    required this.onOpen,
    required this.onPermission,
    required this.onQuestion,
    this.onHuman,
    super.key,
  });

  final RemoteRequest request;
  final RemoteAgent agent;
  final VoidCallback onOpen;
  final Future<String> Function(bool allow) onPermission;
  final Future<String> Function(List<QuestionResponse> responses) onQuestion;
  final Future<String> Function(String choice)? onHuman;

  @override
  State<_RequestCard> createState() => _RequestCardState();
}

class _RequestCardState extends State<_RequestCard> {
  bool _busy = false;
  String? _result;

  Future<void> _run(Future<String> Function() send) async {
    if (_busy) return;
    setState(() => _busy = true);
    final result = await send();
    if (mounted) {
      setState(() {
        _busy = false;
        _result = result;
      });
    }
  }

  Future<void> _permission(bool allow) =>
      _run(() => widget.onPermission(allow));

  Future<void> _question(String label) => _run(
    () => widget.onQuestion([
      QuestionLabels([label]),
    ]),
  );

  Future<void> _human(String choice) {
    final answer = widget.onHuman;
    return answer == null ? Future.value() : _run(() => answer(choice));
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final body = widget.request.body;
    final human = body is BrowserUserRequestBody;
    final single =
        body is QuestionRequestBody &&
        body.questions.length == 1 &&
        !body.questions.first.multiSelect;
    final (icon, label) = switch (body) {
      PermissionRequestBody() => ('terminal-window', '명령 실행 승인'),
      QuestionRequestBody() => (
        'chat-circle-dots',
        body.questions.length > 1
            ? '질문 ${body.questions.length}개'
            : body.questions.first.multiSelect
            ? '질문 · 여러 개 선택'
            : body.questions.first.options.isEmpty
            ? '질문'
            : '질문 · 하나 고르기',
      ),
      BrowserUserRequestBody() => ('user', '사람이 할 일'),
    };
    return Material(
      key: Key('request-${widget.request.ref}'),
      color: colors.level1,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: colors.separator),
      ),
      child: InkWell(
        onTap: widget.onOpen,
        borderRadius: BorderRadius.circular(16),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 11, 12, 11),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 24,
                    height: 24,
                    decoration: BoxDecoration(
                      color: human ? colors.dangerTint : colors.tint2,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    alignment: Alignment.center,
                    child: IrisIcon(
                      icon,
                      size: 15,
                      color: human ? colors.dangerText : colors.link,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      label,
                      key: Key('home-request-title-${widget.request.ref}'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: colors.foreground2,
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  Text(
                    _relativeTime(widget.request.createdAt),
                    key: Key('home-agent-time-${widget.request.ref}'),
                    style: TextStyle(
                      color: colors.muted,
                      fontSize: 12.5,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                  IrisIcon('caret-right', size: 14, color: colors.muted),
                ],
              ),
              const SizedBox(height: 7),
              if (body case PermissionRequestBody())
                _HomeCommand(command: visibleControlCharacters(body.input))
              else if (body case QuestionRequestBody())
                Text(
                  body.questions.first.question,
                  key: Key('home-question-title-${widget.request.ref}'),
                  maxLines: 4,
                  overflow: TextOverflow.ellipsis,
                  style: _bodyStyle(colors),
                )
              else if (body case BrowserUserRequestBody())
                Text(
                  body.title,
                  key: Key('home-human-title-${widget.request.ref}'),
                  maxLines: 4,
                  overflow: TextOverflow.ellipsis,
                  style: _bodyStyle(colors),
                ),
              if (single) ...[
                const SizedBox(height: 7),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final entry
                        in body.questions.first.options.take(6).indexed)
                      _NumberedChoice(
                        key: ValueKey(
                          'home-choice-${widget.request.ref}-${entry.$1 + 1}',
                        ),
                        number: entry.$1 + 1,
                        label: entry.$2.label,
                        onPressed: _busy
                            ? null
                            : () => _question(entry.$2.label),
                      ),
                  ],
                ),
              ],
              const SizedBox(height: 7),
              ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 40),
                child: Row(
                  children: [
                    IrisStatusGlyph(
                      status: human ? 'blocked' : _glyph(body),
                      size: 16,
                    ),
                    const SizedBox(width: 7),
                    Expanded(
                      child: Text(
                        widget.agent.name,
                        key: Key('home-agent-name-${widget.request.ref}'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: colors.foreground2,
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    ..._actions(body),
                  ],
                ),
              ),
              if (_result != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    _result!,
                    style: TextStyle(color: colors.muted, fontSize: 13),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  String _glyph(RemoteRequestBody body) =>
      body is QuestionRequestBody ? 'question' : 'blocked';

  TextStyle _bodyStyle(IrisColors colors) => TextStyle(
    color: colors.foreground,
    fontSize: 15.5,
    fontWeight: FontWeight.w500,
    height: 1.45,
  );

  List<Widget> _actions(RemoteRequestBody body) => switch (body) {
    PermissionRequestBody() => [
      IrisButton(
        key: const Key('home-deny'),
        label: '거절',
        height: 36,
        expand: false,
        onPressed: _busy ? null : () => _permission(false),
      ),
      const SizedBox(width: 6),
      IrisButton(
        key: const Key('home-allow'),
        label: _busy ? '처리 중…' : '허용',
        tone: IrisButtonTone.primary,
        height: 36,
        expand: false,
        onPressed: _busy ? null : () => _permission(true),
      ),
    ],
    QuestionRequestBody() => [
      IrisButton(
        key: Key('home-answer-${widget.request.ref}'),
        label: '답하기',
        tone: IrisButtonTone.primary,
        height: 36,
        expand: false,
        onPressed: widget.onOpen,
      ),
    ],
    BrowserUserRequestBody() => [
      IrisButton(
        key: Key('home-human-open-${widget.request.ref}'),
        label: '탭 열기',
        icon: 'arrow-square-out',
        height: 36,
        expand: false,
        onPressed: body.tab == null ? null : widget.onOpen,
      ),
      const SizedBox(width: 6),
      IrisButton(
        key: Key('home-human-done-${widget.request.ref}'),
        label: '다 했음',
        tone: IrisButtonTone.primary,
        height: 36,
        expand: false,
        onPressed: _busy ? null : () => _human('done'),
      ),
    ],
  };
}

// 승인 요청 명령. 코드 바탕 칩 + 복사
class _HomeCommand extends StatelessWidget {
  const _HomeCommand({required this.command});

  final String command;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        key: const Key('home-command'),
        padding: const EdgeInsets.fromLTRB(9, 3, 2, 3),
        decoration: BoxDecoration(
          color: colors.terminal,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: colors.separator),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              child: IrisCommandText(
                command: command,
                style: IrisType.mono.copyWith(
                  color: colors.foreground,
                  fontSize: 14.5,
                  fontWeight: FontWeight.w500,
                  height: 1.4,
                ),
              ),
            ),
            SizedBox.square(
              dimension: 32,
              child: TextButton(
                onPressed: () =>
                    Clipboard.setData(ClipboardData(text: command)),
                style: const ButtonStyle(
                  padding: WidgetStatePropertyAll(EdgeInsets.zero),
                ),
                child: IrisIcon('copy', size: 16, color: colors.muted),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// 선택지 알약. 번호 + 이름, 누르면 바로 답을 보낸다
class _NumberedChoice extends StatelessWidget {
  const _NumberedChoice({
    required this.number,
    required this.label,
    required this.onPressed,
    super.key,
  });

  final int number;
  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return SizedBox(
      height: 36,
      child: TextButton(
        onPressed: onPressed,
        style: ButtonStyle(
          minimumSize: const WidgetStatePropertyAll(Size.zero),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          padding: const WidgetStatePropertyAll(
            EdgeInsets.symmetric(horizontal: 14),
          ),
          backgroundColor: WidgetStatePropertyAll(colors.level2),
          foregroundColor: WidgetStatePropertyAll(colors.foreground),
          shape: WidgetStatePropertyAll(
            RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(IrisRadius.pill),
              side: BorderSide(color: colors.separator),
            ),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '$number',
              style: TextStyle(
                color: colors.muted,
                fontFamily: 'monospace',
                fontSize: 12,
                height: 1.2,
              ),
            ),
            const SizedBox(width: 7),
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w600,
                  height: 1.2,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// 세션 줄 오른쪽 안내. 강조(알약)이면 답할 일이 있는 줄
class _RowAction extends StatelessWidget {
  const _RowAction({required this.label, this.onTap, this.accent = false});

  final String label;
  final VoidCallback? onTap;
  final bool accent;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    if (accent) {
      return GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          height: 30,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: colors.brand,
            borderRadius: BorderRadius.circular(9),
          ),
          child: Text(
            label,
            style: TextStyle(
              color: colors.onBrand,
              fontSize: 13,
              fontWeight: FontWeight.w600,
              height: 1,
            ),
          ),
        ),
      );
    }
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label,
          style: TextStyle(
            color: colors.muted,
            fontSize: 13,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(width: 2),
        IrisIcon('caret-right', size: 16, color: colors.muted),
      ],
    );
  }
}

// 세션·탭 공통 줄. 앞 표식 / 이름 / 메타 줄 / 오른쪽 안내
class _ListRow extends StatelessWidget {
  const _ListRow({
    required this.leading,
    required this.title,
    required this.meta,
    required this.action,
    required this.onTap,
    this.indent = 0,
  });

  final Widget leading;
  final Widget title;
  final List<Widget> meta;
  final Widget action;
  final VoidCallback onTap;
  final double indent;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 64),
        padding: EdgeInsets.fromLTRB(14 + indent, 10, 12, 10),
        child: Row(
          children: [
            leading,
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  title,
                  const SizedBox(height: 2),
                  SizedBox(height: 20, child: Row(children: meta)),
                ],
              ),
            ),
            const SizedBox(width: 12),
            action,
          ],
        ),
      ),
    );
  }
}

class _MetaText extends StatelessWidget {
  const _MetaText(this.text, {this.strong = false, this.color});

  final String text;
  final bool strong;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Flexible(
      child: Text(
        text,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: color ?? (strong ? colors.foreground2 : colors.muted),
          fontSize: 12.5,
          height: 20 / 12.5,
        ),
      ),
    );
  }
}

class _Dot extends StatelessWidget {
  const _Dot();

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 6),
    child: Text(
      '·',
      style: TextStyle(color: context.iris.muted, fontSize: 12.5),
    ),
  );
}

class _BrowserRow extends StatelessWidget {
  const _BrowserRow({
    required this.tab,
    required this.space,
    required this.onTap,
    this.group,
  });

  final BrowserTab tab;
  final String space;
  final VoidCallback onTap;
  final BrowserTabGroupInfo? group;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final host = Uri.tryParse(tab.url)?.host;
    return KeyedSubtree(
      key: Key('browser-tab-${tab.ref}'),
      child: _ListRow(
        leading: SizedBox.square(
          dimension: 18,
          child: IrisIcon(
            tab.url.contains('github.com') ? 'github-logo' : 'globe',
            size: 18,
            color: colors.foreground2,
          ),
        ),
        title: Text(
          '${group == null ? '' : '${group!.name} · '}${tab.title.isEmpty ? (host ?? tab.url) : tab.title}',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: browserGroupColor(group?.color) ?? colors.foreground,
            fontSize: 15,
            fontWeight: FontWeight.w500,
            height: 21 / 15,
          ),
        ),
        meta: [
          _MetaText(space),
          const _Dot(),
          if (tab.aiControlled) ...[
            Container(
              key: Key('browser-ai-dot-${tab.ref}'),
              width: 6,
              height: 6,
              decoration: BoxDecoration(
                color: colors.pink,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 5),
            _MetaText(
              '${tab.controlling.isEmpty ? 'AI' : tab.controlling.join(', ')}가 조작 중',
              color: colors.dangerText,
            ),
          ] else
            _MetaText(tab.profile),
        ],
        action: const _RowAction(label: '열기'),
        onTap: onTap,
      ),
    );
  }
}

class _AgentSpace {
  const _AgentSpace({
    required this.ref,
    required this.label,
    required this.order,
    required this.nodes,
  });

  final String ref;
  final String label;
  final int order;
  final List<_VisibleAgentNode> nodes;
}

class _AgentNode {
  _AgentNode(this.agent);

  final RemoteAgent agent;
  final List<_AgentNode> children = [];
}

class _VisibleAgentNode {
  const _VisibleAgentNode(this.agent, this.depth);

  final RemoteAgent agent;
  final int depth;
}

List<_AgentSpace> _agentSpaces(List<RemoteAgent> agents) {
  final ordered = [...agents]
    ..sort(
      (a, b) => a.spaceOrder.compareTo(b.spaceOrder) != 0
          ? a.spaceOrder.compareTo(b.spaceOrder)
          : a.sessionOrder.compareTo(b.sessionOrder),
    );
  final grouped = <String, List<RemoteAgent>>{};
  for (final agent in ordered) {
    grouped.putIfAbsent(agent.spaceRef, () => []).add(agent);
  }
  return [
    for (final entry in grouped.entries)
      _AgentSpace(
        ref: entry.key,
        label: entry.value.first.space,
        order: entry.value.first.spaceOrder,
        nodes: _visibleAgentNodes(entry.value),
      ),
  ]..sort((a, b) => a.order.compareTo(b.order));
}

List<_VisibleAgentNode> _visibleAgentNodes(List<RemoteAgent> agents) {
  final nodes = [for (final agent in agents) _AgentNode(agent)];
  final byRef = {for (final node in nodes) node.agent.ref: node};
  final candidates = <_AgentNode, _AgentNode>{};
  for (final node in nodes) {
    final parent = byRef[node.agent.parent];
    if (parent != null && parent != node) candidates[node] = parent;
  }

  bool cyclic(_AgentNode start) {
    final seen = <_AgentNode>{};
    var current = start;
    while (true) {
      final parent = candidates[current];
      if (parent == null) return false;
      if (parent == start) return true;
      if (!seen.add(parent)) return false;
      current = parent;
    }
  }

  final children = <_AgentNode>{};
  for (final node in nodes) {
    final parent = candidates[node];
    if (parent == null || cyclic(node)) continue;
    parent.children.add(node);
    children.add(node);
  }
  final visible = <_VisibleAgentNode>[];
  void walk(_AgentNode node, int depth) {
    visible.add(_VisibleAgentNode(node.agent, depth));
    for (final child in node.children) {
      walk(child, depth + 1);
    }
  }

  for (final node in nodes) {
    if (!children.contains(node)) walk(node, 0);
  }
  return visible;
}

int _compareRecent(RemoteAgent a, RemoteAgent b) {
  final activity = (b.lastActivityAt ?? -1).compareTo(a.lastActivityAt ?? -1);
  if (activity != 0) return activity;
  final space = a.spaceOrder.compareTo(b.spaceOrder);
  return space != 0 ? space : a.sessionOrder.compareTo(b.sessionOrder);
}

class _AgentRow extends StatelessWidget {
  const _AgentRow({
    required this.agent,
    required this.onTap,
    required this.onOpenRequest,
    required this.onOpenWaiting,
    this.request,
    this.depth = 0,
    this.showSpace = false,
  });

  final RemoteAgent agent;
  final VoidCallback onTap;
  final void Function(RemoteRequest request, RemoteAgent agent) onOpenRequest;
  final ValueChanged<RemoteAgent>? onOpenWaiting;
  final RemoteRequest? request;
  final int depth;
  final bool showSpace;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final terminal = agent.kind == 'terminal';
    final status = agent.question ? 'question' : agent.status;
    final waiting =
        !terminal && (request != null || status == 'blocked' || agent.question);
    final request_ = request;
    final answer = request_ != null
        ? () => onOpenRequest(request_, agent)
        : terminal && onOpenWaiting != null
        ? () => onOpenWaiting!(agent)
        : onTap;
    return KeyedSubtree(
      key: Key('agent-row-${agent.ref}'),
      child: _ListRow(
        indent: depth * 18.0,
        leading: SizedBox.square(
          dimension: 18,
          child: terminal
              ? IrisIcon(
                  'terminal-window',
                  key: Key('agent-tile-${agent.ref}'),
                  size: 18,
                  color: colors.muted,
                )
              : IrisStatusGlyph(
                  key: Key('agent-tile-${agent.ref}'),
                  status: status,
                ),
        ),
        title: Text(
          agent.name,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: colors.foreground,
            fontSize: 15,
            fontWeight: FontWeight.w500,
            height: 21 / 15,
          ),
        ),
        meta: [
          IrisKindTag(kind: agent.kind),
          const SizedBox(width: 6),
          if (showSpace) ...[_MetaText(agent.space), const _Dot()],
          if (!terminal) ...[
            _MetaText(_statusLabel(status), strong: true),
            const _Dot(),
          ],
          _MetaText(_relativeTime(agent.lastActivityAt)),
        ],
        action: waiting
            ? _RowAction(
                accent: true,
                label: request_?.body is PermissionRequestBody ? '승인하기' : '답하기',
                onTap: answer,
              )
            : _RowAction(label: _actionLabel(agent, status)),
        onTap: onTap,
      ),
    );
  }
}

String _actionLabel(RemoteAgent agent, String status) {
  if (agent.kind == 'terminal') return '열기';
  return switch (status) {
    'working' => '지켜보기',
    'done' => '결과 보기',
    _ => '열기',
  };
}

String _statusLabel(String status) => switch (status) {
  'working' => '작업 중',
  'idle' => '대기',
  'done' => '완료',
  'blocked' => '답 필요',
  'question' => '질문 있음',
  _ => '상태 알 수 없음',
};

String _relativeTime(int? timestamp) {
  if (timestamp == null) return '기록 없음';
  final elapsed = DateTime.now().millisecondsSinceEpoch - timestamp;
  if (elapsed < 60000) return '방금';
  if (elapsed < 3600000) return '${elapsed ~/ 60000}분 전';
  if (elapsed < 86400000) return '${elapsed ~/ 3600000}시간 전';
  return '${elapsed ~/ 86400000}일 전';
}
