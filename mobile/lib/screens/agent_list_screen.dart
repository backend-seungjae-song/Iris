import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:iris_remote/design/agent_tile.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/command_text.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/markdown_text.dart';
import 'package:iris_remote/design/sheet.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/format/control_characters.dart';
import 'package:iris_remote/format/result_text.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/agent_screen.dart';
import 'package:iris_remote/screens/terminal_screen.dart';
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
    super.key,
  });

  final RemoteState state;
  final VoidCallback onDisconnect;
  final VoidCallback onUnregister;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: state,
      builder: (context, _) => AgentHomeView(
        agents: state.agents
            .where(
              (agent) =>
                  agent.kind != 'terminal' || state.supports('terminal.watch'),
            )
            .toList(),
        requests: state.requests,
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
          if (request.body is PermissionRequestBody) {
            final denied = await showPermissionRequestSheet(
              context: context,
              request: request,
              state: state,
              agentName: agent.name,
              agentKind: agent.kind,
              space: agent.space,
            );
            if (denied && context.mounted) {
              await Navigator.of(context).push<void>(
                MaterialPageRoute(
                  builder: (_) => AgentScreen(
                    state: state,
                    agentRef: agent.ref,
                    focusComposer: true,
                  ),
                ),
              );
            }
          } else if (request.body is QuestionRequestBody) {
            await showQuestionRequestSheet(
              context: context,
              request: request,
              state: state,
              agentName: agent.name,
              agentKind: agent.kind,
              space: agent.space,
            );
          } else if (request.body is BrowserUserRequestBody) {
            await showHumanTurnSheet(
              context: context,
              state: state,
              request: request,
              agent: agent,
              onOpenTab: () => _openHumanTab(context, request, agent),
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

  final List<RemoteAgent> agents;
  final List<RemoteRequest> requests;
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
  final Set<String> _resolved = {};
  final Set<String> _collapsedSpaces = {};
  _HomeSort _sort = _HomeSort.iris;

  @override
  Widget build(BuildContext context) {
    final pending = widget.requests
        .where(
          (request) =>
              !_resolved.contains(request.ref) &&
              _agent(request.agent)?.kind != 'terminal',
        )
        .toList(growable: false);
    final requestedAgents = pending.map((request) => request.agent).toSet();
    final listedAgents = widget.agents
        .where((agent) => !requestedAgents.contains(agent.ref))
        .toList(growable: false);
    final spaces = _agentSpaces(listedAgents);
    final recent = [...listedAgents]..sort(_compareRecent);

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: ListView(
          key: const Key('home-scroll'),
          padding: EdgeInsets.only(
            bottom: 14 + MediaQuery.paddingOf(context).bottom,
          ),
          children: [
            SizedBox(
              key: const Key('home-header'),
              height: 50,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 10, 20, 0),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      '에이전트',
                      key: const Key('home-title'),
                      style: IrisType.title.copyWith(
                        color: context.iris.foreground,
                      ),
                    ),
                    Row(
                      children: [
                        IrisRoundButton(
                          key: const Key('home-sort'),
                          icon: _sort == _HomeSort.iris ? 'stack' : 'clock',
                          tooltip: _sort == _HomeSort.iris
                              ? '정렬: Iris 순서'
                              : '정렬: 최근 활동순',
                          onPressed: _showSortOptions,
                        ),
                        const SizedBox(width: 8),
                        IrisRoundButton(
                          key: const Key('home-settings'),
                          icon: 'gear-six',
                          tooltip: '설정',
                          onPressed: widget.onSettings,
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
            SizedBox(
              key: const Key('home-connection'),
              height: 26,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 6, 20, 0),
                child: Row(
                  children: [
                    Container(
                      key: const Key('home-live-dot'),
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(
                        color: context.iris.working,
                        borderRadius: BorderRadius.circular(4),
                        boxShadow: [
                          BoxShadow(
                            color: context.iris.working.withValues(alpha: 0.14),
                            spreadRadius: 3,
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 7),
                    Expanded(
                      child: Text(
                        '${widget.connectionName} · 실시간 · 1초 전 확인',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: context.iris.muted,
                          fontSize: 15,
                          height: 18 / 15,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            AnimatedSize(
              duration: const Duration(milliseconds: 320),
              curve: const Cubic(0.22, 1, 0.36, 1),
              alignment: Alignment.topCenter,
              child: pending.isEmpty
                  ? const SizedBox(width: double.infinity)
                  : Column(
                      children: [
                        _SectionHeader(
                          key: const Key('home-needed-header'),
                          label: '답이 필요함',
                          count: pending.length,
                          hot: true,
                        ),
                        for (final entry in pending.indexed)
                          if (_agent(entry.$2.agent) case final agent?)
                            _RequestRow(
                              key: ValueKey(entry.$2.ref),
                              request: entry.$2,
                              agent: agent,
                              showDivider: entry.$1 > 0,
                              onOpen: () =>
                                  widget.onOpenRequest(entry.$2, agent),
                              onPermission: (allow) =>
                                  _answerPermission(entry.$2, allow),
                              onQuestion: (responses) =>
                                  _answerQuestion(entry.$2, responses),
                              onHuman: widget.onAnswerHuman == null
                                  ? null
                                  : (choice) => _answerHuman(entry.$2, choice),
                            ),
                      ],
                    ),
            ),
            if (_sort == _HomeSort.iris)
              for (final space in spaces) ...[
                _SpaceHeader(
                  key: Key('home-space-${space.ref}'),
                  label: space.label,
                  count: space.nodes.length,
                  expanded: !_collapsedSpaces.contains(space.ref),
                  onTap: () => setState(() {
                    if (!_collapsedSpaces.add(space.ref)) {
                      _collapsedSpaces.remove(space.ref);
                    }
                  }),
                ),
                if (!_collapsedSpaces.contains(space.ref))
                  for (final node in space.nodes)
                    _AgentRow(
                      agent: node.agent,
                      depth: node.depth,
                      quiet: node.agent.status != 'working',
                      onTap: () => widget.onOpenAgent(node.agent),
                    ),
              ]
            else if (recent.isNotEmpty) ...[
              _SectionHeader(
                key: const Key('home-recent-header'),
                label: '최근 활동순',
                count: recent.length,
              ),
              for (final agent in recent)
                _AgentRow(
                  agent: agent,
                  quiet: agent.status != 'working',
                  onTap: () => widget.onOpenAgent(agent),
                ),
            ],
            if (widget.browserTabs.isNotEmpty &&
                widget.onOpenBrowserTab != null) ...[
              _SectionHeader(
                key: const Key('home-browser-header'),
                label: '브라우저 탭',
                count: widget.browserTabs.length,
              ),
              for (final group in browserGroups(
                widget.browserSpaces,
                widget.browserTabs,
                widget.agents,
              )) ...[
                _SectionHeader(
                  label: '${group.space.name} · ${group.name}',
                  count: group.tabs.length,
                ),
                for (final tab in group.tabs)
                  _BrowserRow(
                    tab: tab,
                    space: group.space.name,
                    group: widget.browserTabGroups
                        .where((item) => item.ref == tab.group)
                        .firstOrNull,
                    onTap: () => widget.onOpenBrowserGroupTab != null
                        ? widget.onOpenBrowserGroupTab!(tab, group.agent)
                        : widget.onOpenBrowserTab!(tab),
                  ),
              ],
            ],
            if (widget.agents.isEmpty && pending.isEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 64, 20, 0),
                child: Text(
                  '열려 있는 에이전트가 없습니다.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: context.iris.muted, fontSize: 15),
                ),
              ),
          ],
        ),
      ),
    );
  }

  RemoteAgent? _agent(String ref) {
    for (final agent in widget.agents) {
      if (agent.ref == ref) return agent;
    }
    return null;
  }

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
            '에이전트 정렬',
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

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({
    required this.label,
    required this.count,
    this.hot = false,
    super.key,
  });

  final String label;
  final int count;
  final bool hot;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 62,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 30, 20, 10),
        child: Row(
          children: [
            SizedBox(
              width: hot ? 68.2 : null,
              child: Text(
                label,
                maxLines: 1,
                softWrap: false,
                style: IrisType.label.copyWith(color: context.iris.foreground2),
              ),
            ),
            const SizedBox(width: 8),
            Container(
              key: hot ? const Key('home-needed-count') : null,
              width: count < 10 ? 22.4 : null,
              constraints: const BoxConstraints(minWidth: 22),
              height: 22,
              padding: const EdgeInsets.symmetric(horizontal: 7),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: hot
                    ? context.iris.blocked.withValues(
                        alpha: Theme.of(context).brightness == Brightness.dark
                            ? 0.16
                            : 0.12,
                      )
                    : context.iris.level2,
                borderRadius: BorderRadius.circular(11),
              ),
              child: Text(
                '$count',
                style: TextStyle(
                  color: hot ? context.iris.blocked : context.iris.foreground2,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  height: 16 / 13,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SpaceHeader extends StatelessWidget {
  const _SpaceHeader({
    required this.label,
    required this.count,
    required this.expanded,
    required this.onTap,
    super.key,
  });

  final String label;
  final int count;
  final bool expanded;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 52,
      child: TextButton(
        onPressed: onTap,
        style: const ButtonStyle(
          padding: WidgetStatePropertyAll(EdgeInsets.fromLTRB(20, 12, 20, 8)),
          shape: WidgetStatePropertyAll(RoundedRectangleBorder()),
          alignment: Alignment.centerLeft,
        ),
        child: Row(
          children: [
            IrisIcon(
              expanded ? 'caret-down' : 'caret-right',
              size: 15,
              color: context.iris.faint,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: IrisType.label.copyWith(color: context.iris.foreground2),
              ),
            ),
            Container(
              constraints: const BoxConstraints(minWidth: 22),
              height: 22,
              padding: const EdgeInsets.symmetric(horizontal: 7),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: context.iris.level2,
                borderRadius: BorderRadius.circular(11),
              ),
              child: Text(
                '$count',
                style: TextStyle(
                  color: context.iris.foreground2,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  height: 16 / 13,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _RequestRow extends StatefulWidget {
  const _RequestRow({
    required this.request,
    required this.agent,
    required this.onOpen,
    required this.onPermission,
    required this.onQuestion,
    this.onHuman,
    this.showDivider = false,
    super.key,
  });

  final RemoteRequest request;
  final RemoteAgent agent;
  final VoidCallback onOpen;
  final Future<String> Function(bool allow) onPermission;
  final Future<String> Function(List<QuestionResponse> responses) onQuestion;
  final Future<String> Function(String choice)? onHuman;
  final bool showDivider;

  @override
  State<_RequestRow> createState() => _RequestRowState();
}

class _RequestRowState extends State<_RequestRow> {
  bool _busy = false;
  String? _result;

  Future<void> _permission(bool allow) async {
    if (_busy) return;
    setState(() => _busy = true);
    final result = await widget.onPermission(allow);
    if (mounted) {
      setState(() {
        _busy = false;
        _result = result;
      });
    }
  }

  Future<void> _question(String label) async {
    if (_busy) return;
    setState(() => _busy = true);
    final result = await widget.onQuestion([
      QuestionLabels([label]),
    ]);
    if (mounted) {
      setState(() {
        _busy = false;
        _result = result;
      });
    }
  }

  Future<void> _human(String choice) async {
    if (_busy || widget.onHuman == null) return;
    setState(() => _busy = true);
    final result = await widget.onHuman!(choice);
    if (mounted) {
      setState(() {
        _busy = false;
        _result = result;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final body = widget.request.body;
    return Container(
      key: Key('request-${widget.request.ref}'),
      padding: const EdgeInsets.fromLTRB(20, 14, 20, 16),
      decoration: widget.showDivider
          ? BoxDecoration(
              border: Border(top: BorderSide(color: context.iris.separator)),
            )
          : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              IrisAgentTile(
                key: Key('home-agent-tile-${widget.request.ref}'),
                statusKey: Key('home-status-${widget.request.ref}'),
                kind: widget.agent.kind,
                status:
                    body is PermissionRequestBody ||
                        body is BrowserUserRequestBody
                    ? 'blocked'
                    : 'question',
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(top: 3),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        widget.agent.name,
                        key: Key('home-agent-name-${widget.request.ref}'),
                        style: IrisType.rowTitle,
                      ),
                      const SizedBox(height: 1),
                      Text(
                        body is BrowserUserRequestBody
                            ? '${widget.agent.space} · 브라우저'
                            : widget.agent.space,
                        key: Key('home-agent-space-${widget.request.ref}'),
                        style: TextStyle(
                          color: context.iris.muted,
                          fontSize: 14,
                          height: 17 / 14,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 13.5),
              Padding(
                padding: const EdgeInsets.only(top: 3),
                child: Text(
                  _relativeTime(widget.agent.lastActivityAt),
                  key: Key('home-agent-time-${widget.request.ref}'),
                  style: IrisType.meta.copyWith(color: context.iris.faint),
                ),
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(left: 58, top: 10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (body case PermissionRequestBody()) ...[
                  SizedBox(
                    key: const Key('home-request-title'),
                    height: 21.75,
                    child: Text(
                      '명령 실행 허용',
                      style: TextStyle(
                        color: context.iris.blocked,
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        height: 1.45,
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  _HomeCommand(command: visibleControlCharacters(body.input)),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      IrisButton(
                        key: const Key('home-allow'),
                        label: _busy ? '처리 중…' : '허용',
                        tone: IrisButtonTone.primary,
                        height: 36,
                        expand: false,
                        onPressed: _busy ? null : () => _permission(true),
                      ),
                      IrisButton(
                        key: const Key('home-deny'),
                        label: '거절',
                        tone: IrisButtonTone.danger,
                        height: 36,
                        expand: false,
                        onPressed: _busy ? null : () => _permission(false),
                      ),
                      IrisButton(
                        key: const Key('home-open'),
                        label: '열기',
                        tone: IrisButtonTone.ghost,
                        height: 36,
                        expand: false,
                        onPressed: widget.onOpen,
                      ),
                    ],
                  ),
                ] else if (body case QuestionRequestBody()) ...[
                  IrisMarkdown(
                    '${body.questions.length == 1 ? '**질문**' : '**질문 ${body.questions.length}개**'} · ${body.questions.first.question}',
                    key: Key('home-question-title-${widget.request.ref}'),
                    compact: true,
                    selectable: false,
                    baseStyle: TextStyle(
                      color: context.iris.foreground2,
                      fontSize: 15,
                      height: 1.45,
                    ),
                    textColor: context.iris.foreground2,
                  ),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final entry
                          in body.questions.first.options.take(2).indexed)
                        _NumberedChoice(
                          key: ValueKey(
                            'home-choice-${widget.request.ref}-${entry.$1 + 1}',
                          ),
                          number: entry.$1 + 1,
                          label: entry.$2.label,
                          onPressed: body.questions.length == 1 && !_busy
                              ? () => _question(entry.$2.label)
                              : widget.onOpen,
                        ),
                      IrisButton(
                        label: '직접 답하기',
                        tone: IrisButtonTone.ghost,
                        height: 36,
                        expand: false,
                        onPressed: widget.onOpen,
                      ),
                    ],
                  ),
                ] else if (body case BrowserUserRequestBody()) ...[
                  IrisMarkdown(
                    '**사람 차례** · ${body.title}',
                    key: Key('home-human-title-${widget.request.ref}'),
                    compact: true,
                    selectable: false,
                    baseStyle: TextStyle(
                      color: context.iris.foreground2,
                      fontSize: 15,
                      height: 1.45,
                    ),
                    textColor: context.iris.foreground2,
                  ),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      IrisButton(
                        key: Key('home-human-open-${widget.request.ref}'),
                        label: '탭 열기',
                        icon: 'globe',
                        tone: IrisButtonTone.primary,
                        height: 36,
                        expand: false,
                        onPressed: body.tab == null ? null : widget.onOpen,
                      ),
                      IrisButton(
                        key: Key('home-human-done-${widget.request.ref}'),
                        label: '다 했음',
                        height: 36,
                        expand: false,
                        onPressed: _busy ? null : () => _human('done'),
                      ),
                    ],
                  ),
                ],
                if (_result != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      _result!,
                      style: TextStyle(color: context.iris.muted, fontSize: 13),
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

class _HomeCommand extends StatelessWidget {
  const _HomeCommand({required this.command});

  final String command;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const Key('home-command'),
      width: double.infinity,
      height: 60.5,
      padding: const EdgeInsets.fromLTRB(12, 10, 40, 10),
      decoration: BoxDecoration(
        color: context.iris.level1,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                r'$',
                style: IrisType.mono.copyWith(
                  color: context.iris.faint,
                  fontSize: 13.5,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: IrisCommandText(
                  command: command,
                  style: IrisType.mono.copyWith(
                    color: context.iris.foreground2,
                    fontSize: 13.5,
                  ),
                ),
              ),
            ],
          ),
          Positioned(
            top: -7,
            right: -37,
            child: SizedBox.square(
              dimension: 32,
              child: TextButton(
                onPressed: () =>
                    Clipboard.setData(ClipboardData(text: command)),
                style: const ButtonStyle(
                  padding: WidgetStatePropertyAll(EdgeInsets.zero),
                ),
                child: IrisIcon('copy', size: 16, color: context.iris.muted),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _NumberedChoice extends StatelessWidget {
  const _NumberedChoice({
    required this.number,
    required this.label,
    required this.onPressed,
    super.key,
  });

  final int number;
  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 36,
      child: TextButton(
        onPressed: onPressed,
        style: ButtonStyle(
          padding: const WidgetStatePropertyAll(
            EdgeInsets.symmetric(horizontal: 14),
          ),
          backgroundColor: WidgetStatePropertyAll(context.iris.level2),
          foregroundColor: WidgetStatePropertyAll(context.iris.foreground),
          shape: WidgetStatePropertyAll(
            RoundedRectangleBorder(borderRadius: BorderRadius.circular(11)),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '$number',
              style: TextStyle(
                color: context.iris.muted,
                fontFamily: 'monospace',
                fontSize: 12,
                height: 1.2,
              ),
            ),
            const SizedBox(width: 7),
            Text(
              label,
              style: const TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w600,
                height: 1.2,
              ),
            ),
          ],
        ),
      ),
    );
  }
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
    final host = Uri.tryParse(tab.url)?.host;
    return SizedBox(
      key: Key('browser-tab-${tab.ref}'),
      height: 66,
      child: TextButton(
        onPressed: onTap,
        style: const ButtonStyle(
          padding: WidgetStatePropertyAll(
            EdgeInsets.symmetric(horizontal: 20, vertical: 11),
          ),
          shape: WidgetStatePropertyAll(RoundedRectangleBorder()),
        ),
        child: Row(
          children: [
            SizedBox(
              width: 44,
              height: 44,
              child: Center(
                child: IrisIcon(
                  tab.url.contains('github.com') ? 'github-logo' : 'globe',
                  size: 22,
                  color: context.iris.foreground2,
                ),
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${group == null ? '' : '${group!.name} · '}${tab.title.isEmpty ? (host ?? tab.url) : tab.title}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: IrisType.rowTitle.copyWith(
                      color: browserGroupColor(group?.color),
                    ),
                  ),
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      Text(
                        '$space · ',
                        style: TextStyle(
                          color: context.iris.muted,
                          fontSize: 15,
                        ),
                      ),
                      if (tab.aiControlled) ...[
                        Container(
                          key: Key('browser-ai-dot-${tab.ref}'),
                          width: 6,
                          height: 6,
                          decoration: const BoxDecoration(
                            color: Color(0xfff4a1a7),
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 5),
                        Expanded(
                          child: Text(
                            '${tab.controlling.isEmpty ? 'AI' : tab.controlling.join(', ')}가 조작 중',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: Color(0xfff4a1a7),
                              fontSize: 15,
                            ),
                          ),
                        ),
                      ] else
                        Expanded(
                          child: Text(
                            tab.profile,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: context.iris.muted,
                              fontSize: 15,
                            ),
                          ),
                        ),
                    ],
                  ),
                ],
              ),
            ),
            IrisIcon('caret-right', size: 16, color: context.iris.faint),
          ],
        ),
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
    this.quiet = false,
    this.depth = 0,
  });

  final RemoteAgent agent;
  final VoidCallback onTap;
  final bool quiet;
  final int depth;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      key: Key('agent-row-${agent.ref}'),
      height: 66,
      child: TextButton(
        onPressed: onTap,
        style: ButtonStyle(
          padding: WidgetStatePropertyAll(
            EdgeInsets.fromLTRB(20 + depth * 18, 11, 20, 11),
          ),
          shape: const WidgetStatePropertyAll(RoundedRectangleBorder()),
          alignment: Alignment.centerLeft,
        ),
        child: Row(
          children: [
            IrisAgentTile(
              key: Key('agent-tile-${agent.ref}'),
              statusKey: Key('agent-status-${agent.ref}'),
              kind: agent.kind,
              status: agent.question ? 'question' : agent.status,
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          agent.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: IrisType.rowTitle.copyWith(
                            color: quiet
                                ? context.iris.foreground2
                                : context.iris.foreground,
                            fontWeight: quiet
                                ? FontWeight.w500
                                : FontWeight.w600,
                          ),
                        ),
                      ),
                      Text(
                        _relativeTime(agent.lastActivityAt),
                        style: IrisType.meta.copyWith(
                          color: context.iris.faint,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${agent.space} · ${agent.kind == 'terminal' ? '터미널' : _statusLabel(agent.status)}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: context.iris.muted,
                      fontSize: 15,
                      height: 18 / 15,
                      letterSpacing: -0.075,
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

String _statusLabel(String status) => switch (status) {
  'working' => '작업 중',
  'idle' => '쉬는 중',
  'done' => '작업 완료',
  'blocked' => '허용 대기',
  _ => '상태 알 수 없음',
};

String _relativeTime(int? timestamp) {
  if (timestamp == null) return '기록 없음';
  final elapsed = DateTime.now().millisecondsSinceEpoch - timestamp;
  if (elapsed < 60000) return '방금';
  if (elapsed < 3600000) return '${elapsed ~/ 60000}분';
  if (elapsed < 86400000) return '${elapsed ~/ 3600000}시간';
  return '${elapsed ~/ 86400000}일';
}
