import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';

class ComposerDraft {
  const ComposerDraft({
    required this.ref,
    required this.kind,
    required this.summary,
    required this.content,
  });

  final String ref;
  final String kind;
  final String summary;
  final String content;
}

class RemoteState extends ChangeNotifier {
  RemoteState(this.session);

  final ActiveRemoteSession session;
  final List<StreamSubscription<Object?>> _subscriptions = [];

  List<RemoteAgent> _agents = const [];
  List<RemoteRequest> _requests = const [];
  List<TranscriptItem> _transcript = const [];
  List<BrowserSpace> _browserSpaces = const [];
  List<BrowserTab> _browserTabs = const [];
  List<BrowserTabGroupInfo> _browserTabGroups = const [];
  final Map<String, List<ComposerDraft>> _composerDrafts = {};
  final Map<String, String> _composerTexts = {};
  String? _selectedAgent;
  String? _before;
  String? _transcriptError;
  bool _loadingTranscript = false;
  bool _loadingEarlier = false;
  bool _loadingBrowserTabs = false;
  String? _browserError;
  int _transcriptRequest = 0;

  List<RemoteAgent> get agents => _agents;
  List<RemoteRequest> get requests => _requests;
  List<TranscriptItem> get transcript => _transcript;
  List<BrowserSpace> get browserSpaces => _browserSpaces;
  List<BrowserTab> get browserTabs => _browserTabs;
  List<BrowserTabGroupInfo> get browserTabGroups => _browserTabGroups;
  bool get loadingBrowserTabs => _loadingBrowserTabs;
  String? get browserError => _browserError;
  String get macName => session.macName;
  String? get transcriptError => _transcriptError;
  bool get loadingTranscript => _loadingTranscript;
  bool get loadingEarlier => _loadingEarlier;
  bool get hasEarlier => _before != null;

  List<ComposerDraft> composerDraftsFor(String agent) =>
      List.unmodifiable(_composerDrafts[agent] ?? const []);

  String composerTextFor(String agent) => _composerTexts[agent] ?? '';

  void setComposerText(String agent, String text) {
    if (composerTextFor(agent) == text) return;
    if (text.isEmpty) {
      _composerTexts.remove(agent);
    } else {
      _composerTexts[agent] = text;
    }
    notifyListeners();
  }

  void addBrowserDraft(String agent, BrowserDraftResult result) {
    final current = _composerDrafts[agent] ?? const [];
    _composerDrafts[agent] = List.unmodifiable([
      ...current.where((draft) => draft.ref != result.ref),
      ComposerDraft(
        ref: result.ref,
        kind: result.kind,
        summary: result.summary,
        content: result.content,
      ),
    ]);
    notifyListeners();
  }

  void removeComposerDraft(String agent, String ref) {
    final current = _composerDrafts[agent];
    if (current == null || !current.any((draft) => draft.ref == ref)) return;
    final next = current.where((draft) => draft.ref != ref).toList();
    if (next.isEmpty) {
      _composerDrafts.remove(agent);
    } else {
      _composerDrafts[agent] = List.unmodifiable(next);
    }
    notifyListeners();
    if (supports('browser.draft.remove')) unawaited(_removeServerDraft(ref));
  }

  Future<void> _removeServerDraft(String ref) async {
    try {
      await session.removeBrowserDraft(ref);
    } on RemoteFailure {
      // 연결 종료가 로컬 칩 삭제를 되돌리지 않음
    }
  }

  void clearComposerDrafts(String agent) {
    if (_composerDrafts.remove(agent) != null) notifyListeners();
  }

  Future<void> initialize() async {
    _subscriptions.add(
      session.agents.listen((agents) {
        _agents = agents;
        notifyListeners();
      }),
    );
    _subscriptions.add(
      session.requests.listen((requests) {
        _requests = requests;
        notifyListeners();
      }),
    );
    _subscriptions.add(session.transcriptAppends.listen(_appendTranscript));
    session.watch();
    if (supports('browser.tabs')) unawaited(refreshBrowserTabs());
  }

  bool supports(String request) => session.supports(request);

  BrowserSpace? browserSpace(String ref) {
    for (final space in _browserSpaces) {
      if (space.ref == ref) return space;
    }
    return null;
  }

  BrowserTab? browserTab(String ref) {
    for (final tab in _browserTabs) {
      if (tab.ref == ref) return tab;
    }
    return null;
  }

  Future<void> refreshBrowserTabs() async {
    if (!supports('browser.tabs') || _loadingBrowserTabs) return;
    _loadingBrowserTabs = true;
    _browserError = null;
    notifyListeners();
    try {
      final result = await session.browserTabs();
      _browserSpaces = result.spaces;
      _browserTabs = result.tabs;
      _browserTabGroups = result.groups;
    } on RemoteFailure catch (error) {
      _browserError = error.message;
    } finally {
      _loadingBrowserTabs = false;
      notifyListeners();
    }
  }

  RemoteAgent? agent(String ref) {
    for (final agent in _agents) {
      if (agent.ref == ref) return agent;
    }
    return null;
  }

  List<RemoteRequest> requestsFor(String agent) => _requests
      .where((request) => request.agent == agent)
      .toList(growable: false);

  Future<void> selectAgent(String agent) async {
    final request = ++_transcriptRequest;
    _selectedAgent = agent;
    _transcript = const [];
    _before = null;
    _transcriptError = null;
    _loadingTranscript = true;
    _loadingEarlier = false;
    notifyListeners();
    try {
      session.watchTranscript(agent);
      final page = await session.transcriptPage(agent);
      if (_selectedAgent != agent || request != _transcriptRequest) return;
      _transcript = List.unmodifiable(
        _mergeWithOverlap(page.items.reversed.toList(), _transcript),
      );
      _before = page.before;
    } on RemoteFailure catch (error) {
      if (_selectedAgent == agent && request == _transcriptRequest) {
        _transcriptError = error.message;
      }
    } finally {
      if (_selectedAgent == agent && request == _transcriptRequest) {
        _loadingTranscript = false;
        notifyListeners();
      }
    }
  }

  Future<void> loadEarlier() async {
    final agent = _selectedAgent;
    final before = _before;
    if (agent == null || before == null || _loadingEarlier) return;
    final request = _transcriptRequest;
    _loadingEarlier = true;
    notifyListeners();
    try {
      final page = await session.transcriptPage(agent, before: before);
      if (_selectedAgent != agent || request != _transcriptRequest) return;
      _transcript = List.unmodifiable([...page.items.reversed, ..._transcript]);
      _before = page.before;
      _transcriptError = null;
    } on RemoteFailure catch (error) {
      if (_selectedAgent == agent && request == _transcriptRequest) {
        _transcriptError = error.message;
      }
    } finally {
      if (_selectedAgent == agent && request == _transcriptRequest) {
        _loadingEarlier = false;
        notifyListeners();
      }
    }
  }

  Future<AgentMessageResult> sendMessage(
    String agent,
    String text, {
    List<String> drafts = const [],
  }) => session.messageAgent(agent, text, drafts: drafts);

  Future<AgentMessageResult> sendComposerMessage(
    String agent,
    String text,
  ) async {
    final drafts = composerDraftsFor(agent);
    final response = await sendMessage(
      agent,
      text,
      drafts: drafts.map((draft) => draft.ref).toList(growable: false),
    );
    if (const {'sent', 'delivered'}.contains(response.result)) {
      clearComposerDrafts(agent);
    }
    return response;
  }

  Future<AgentStopResult> stopAgent(String agent) => session.stopAgent(agent);

  Future<RequestAnswerResult> answerPermission(
    RemoteRequest request, {
    required bool allow,
  }) => session.answerPermission(request.ref, allow: allow);

  Future<RequestAnswerResult> answerQuestions(
    RemoteRequest request,
    QuestionRequestBody body,
    List<QuestionResponse> responses,
  ) => session.answerQuestions(request.ref, body, responses);

  Future<RequestAnswerResult> answerBrowserUser(
    RemoteRequest request, {
    required String choice,
  }) => session.answerBrowserUser(request.ref, choice: choice);

  void _appendTranscript(TranscriptAppend append) {
    if (append.agent != _selectedAgent) return;
    _transcript = List.unmodifiable([..._transcript, ...append.items]);
    notifyListeners();
  }

  bool _disposed = false;

  // 연결 종료 뒤 늦게 끝난 요청의 알림 무시. 닫히는 화면의 비동기 작업이 예외를 내지 않게
  @override
  void notifyListeners() {
    if (!_disposed) super.notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    for (final subscription in _subscriptions) {
      unawaited(subscription.cancel());
    }
    super.dispose();
  }
}

bool _sameItem(TranscriptItem left, TranscriptItem right) =>
    left.role == right.role &&
    left.text == right.text &&
    left.tool == right.tool &&
    left.at == right.at;

List<TranscriptItem> _mergeWithOverlap(
  List<TranscriptItem> page,
  List<TranscriptItem> appended,
) {
  final maximum = page.length < appended.length ? page.length : appended.length;
  var overlap = maximum;
  while (overlap > 0) {
    var matches = true;
    for (var index = 0; index < overlap; index++) {
      if (!_sameItem(page[page.length - overlap + index], appended[index])) {
        matches = false;
        break;
      }
    }
    if (matches) break;
    overlap--;
  }
  return [...page, ...appended.skip(overlap)];
}
