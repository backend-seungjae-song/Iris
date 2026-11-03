import 'package:iris_remote/remote/protocol.dart';

Map<String, String> responseItems({
  required List<RemoteRequest> requests,
  required List<RemoteRequest> terminalQuestions,
  required List<RemoteAgent> agents,
}) {
  final items = <String, String>{};
  for (final request in [...requests, ...terminalQuestions]) {
    if (const {
      'claude-permission',
      'claude-question',
      'browser-user',
      'terminal-prompt',
    }.contains(request.kind)) {
      // 터미널 화면 질문은 화면이 바뀔 때마다 ref 가 달라져서 에이전트로 식별
      items[request.kind == 'terminal-prompt'
              ? 'prompt:${request.agent}'
              : 'request:${request.ref}'] =
          request.agent;
    }
  }
  final requestedAgents = items.values.toSet();
  for (final agent in agents) {
    if (agent.kind == 'terminal' || requestedAgents.contains(agent.ref)) {
      continue;
    }
    if (agent.question || agent.status == 'blocked') {
      items['agent:${agent.ref}:${agent.status}:${agent.question}'] = agent.ref;
    }
  }
  return items;
}

class ResponseNotificationUpdate {
  const ResponseNotificationUpdate(this.count, this.alert);
  final int count;
  final bool alert;
  bool get remove => count == 0;
}

class ResponseNotifications {
  Map<String, String> _previous = {};

  ResponseNotificationUpdate update(
    Map<String, String> items, {
    required bool foreground,
    String? visibleAgent,
  }) {
    final added = items.keys.where((id) => !_previous.containsKey(id));
    final alert = added.any(
      (id) =>
          !_isSameRequestSeenAsOtherKind(id, items[id]!) &&
          (!foreground || items[id] != visibleAgent),
    );
    _previous = Map.of(items);
    return ResponseNotificationUpdate(items.length, alert);
  }

  // 같은 요청이 에이전트 상태 항목과 요청 항목으로 번갈아 나타나는 경우.
  // 서버가 두 목록을 따로 보내서 도착 순서에 따라 식별자만 바뀜
  bool _isSameRequestSeenAsOtherKind(String id, String agent) {
    final agentKind = id.startsWith('agent:');
    return _previous.entries.any(
      (entry) =>
          entry.value == agent && entry.key.startsWith('agent:') != agentKind,
    );
  }
}
