import 'dart:convert';
import 'dart:typed_data';

part 'advanced_protocol.dart';

const remoteProtocolVersion = 'remote/1';

final RegExp _hex128 = RegExp(r'^[0-9a-f]{32}$');
final RegExp _sha256 = RegExp(r'^[0-9a-f]{64}$');
final RegExp _pairingSecret = RegExp(r'^[A-Za-z0-9_-]{43}$');
final RegExp _pairingCode = RegExp(r'^\d{6}$');
final RegExp _rid = RegExp(r'^[A-Za-z0-9_-]{1,32}$');
final RegExp _cursor = RegExp(r'^[A-Za-z0-9_-]{1,128}$');
const Set<String> _errorCodes = {
  'invalid-request',
  'unsupported-request',
  'expired',
  'forbidden',
  'busy',
  'limit-exceeded',
  'unavailable',
  'browser-controller-unavailable',
  'browser-tab-unavailable',
  'browser-frame-unavailable',
  'browser-command-unavailable',
  'terminal-stale-screen',
  'terminal-selection-unavailable',
  'terminal-mouse-unavailable',
  'terminal-frame-too-large',
  'terminal-layout-unavailable',
  'terminal-read-unavailable',
};

class ProtocolException implements Exception {
  const ProtocolException(this.message);

  final String message;

  @override
  String toString() => 'ProtocolException: $message';
}

abstract interface class RemoteConnection {
  Future<void> get closed;

  Future<String> receive();

  void sendJson(Map<String, Object> message);

  Future<void> close();
}

class PairingQr {
  const PairingQr({
    required this.address,
    required this.port,
    required this.certHash,
    required this.secret,
  });

  final String address;
  final int port;
  final String certHash;
  final String secret;

  static PairingQr parse(String text) {
    // Mac 원격 화면의 휴대폰 Tailscale 설치 QR
    if (text.contains('com.tailscale.ipn')) {
      throw const ProtocolException(
        'Tailscale 설치 QR입니다. 휴대폰 기본 카메라로 찍으세요. Iris 앱으로는 컴퓨터에서 기기 추가를 눌러 나온 QR을 찍습니다.',
      );
    }
    final Object? decoded;
    try {
      decoded = jsonDecode(text);
    } on FormatException {
      throw const ProtocolException('Iris 연결 QR이 아닙니다.');
    }
    if (!_hasExactKeys(decoded, {
      't',
      'v',
      'address',
      'port',
      'certHash',
      'secret',
    })) {
      throw const ProtocolException('Iris 연결 QR 형식이 올바르지 않습니다.');
    }
    final map = decoded! as Map<String, dynamic>;
    if (map['t'] != 'iris-remote-pair' || map['v'] != 1) {
      throw const ProtocolException('지원하지 않는 Iris 연결 QR입니다.');
    }
    final address = map['address'];
    final port = map['port'];
    final certHash = map['certHash'];
    final secret = map['secret'];
    if (address is! String || !_isIpv4(address)) {
      throw const ProtocolException('컴퓨터 주소가 올바르지 않습니다.');
    }
    if (port is! int || port < 1 || port > 65535) {
      throw const ProtocolException('컴퓨터 연결 포트가 올바르지 않습니다.');
    }
    if (certHash is! String || !_sha256.hasMatch(certHash)) {
      throw const ProtocolException('컴퓨터 인증서 정보가 올바르지 않습니다.');
    }
    if (secret is! String || !_pairingSecret.hasMatch(secret)) {
      throw const ProtocolException('페어링 비밀 정보가 올바르지 않습니다.');
    }
    return PairingQr(
      address: address,
      port: port,
      certHash: certHash,
      secret: secret,
    );
  }
}

class AuthChallenge {
  const AuthChallenge({
    required this.serverInstance,
    required this.connId,
    required this.nonce,
    required this.certHash,
  });

  final String serverInstance;
  final String connId;
  final String nonce;
  final String certHash;

  static AuthChallenge parse(Object? value, {required String pin}) {
    if (!_hasExactKeys(value, {
      'type',
      'v',
      'serverInstance',
      'connId',
      'nonce',
      'certHash',
    })) {
      throw const ProtocolException('컴퓨터가 올바른 연결 정보를 보내지 않았습니다.');
    }
    final map = value! as Map<String, dynamic>;
    if (map['type'] != 'auth.challenge' ||
        map['v'] != remoteProtocolVersion ||
        map['serverInstance'] is! String ||
        !_hex128.hasMatch(map['serverInstance'] as String) ||
        map['connId'] is! String ||
        !_hex128.hasMatch(map['connId'] as String) ||
        map['nonce'] is! String ||
        !_sha256.hasMatch(map['nonce'] as String) ||
        map['certHash'] is! String ||
        !_sha256.hasMatch(map['certHash'] as String)) {
      throw const ProtocolException('컴퓨터가 올바른 연결 정보를 보내지 않았습니다.');
    }
    if (map['certHash'] != pin) {
      throw const ProtocolException('컴퓨터의 인증서가 등록한 것과 다릅니다.');
    }
    return AuthChallenge(
      serverInstance: map['serverInstance'] as String,
      connId: map['connId'] as String,
      nonce: map['nonce'] as String,
      certHash: map['certHash'] as String,
    );
  }

  Map<String, Object> signingTarget(String deviceId) {
    if (!_validString(deviceId, maximum: 256)) {
      throw const ProtocolException('등록된 폰 정보가 올바르지 않습니다.');
    }
    return {
      'domain': 'iris-remote-conn/1',
      'v': 1,
      'serverInstance': serverInstance,
      'connId': connId,
      'deviceId': deviceId,
      'nonce': nonce,
      'certHash': certHash,
    };
  }
}

sealed class ServerMessage {
  const ServerMessage();
}

class PairPending extends ServerMessage {
  const PairPending({required this.deviceId, required this.code});

  final String deviceId;
  final String code;
}

class AuthOk extends ServerMessage {
  const AuthOk({required this.resumeToken, required this.pinIdleMinutes});

  final String resumeToken;
  final int pinIdleMinutes;
}

class PinRequired extends ServerMessage {
  const PinRequired();
}

class PinError extends ServerMessage {
  const PinError({required this.reason, required this.retryAfterMs});

  final String reason;
  final int retryAfterMs;
}

class ServiceStatus extends ServerMessage {
  const ServiceStatus(this.reason);

  final String reason;
}

class Capabilities extends ServerMessage {
  const Capabilities({required this.macName, required this.requests});

  final String macName;
  final List<String> requests;
}

class RemoteError extends ServerMessage {
  const RemoteError(this.code, {this.rid});

  final String code;
  final String? rid;
}

class Pong extends ServerMessage {
  const Pong(this.rid);

  final String rid;
}

class AgentPermissions {
  const AgentPermissions({required this.stop, required this.message});

  final bool stop;
  final bool message;
}

class RemoteAgent {
  const RemoteAgent({
    required this.ref,
    required this.name,
    required this.kind,
    required this.status,
    required this.question,
    required this.space,
    required this.spaceRef,
    required this.spaceOrder,
    required this.sessionOrder,
    required this.parent,
    required this.lastActivityAt,
    required this.can,
  });

  final String ref;
  final String name;
  final String kind;
  final String status;
  final bool question;
  final String space;
  final String spaceRef;
  final int spaceOrder;
  final int sessionOrder;
  final String? parent;
  final int? lastActivityAt;
  final AgentPermissions can;
}

class AgentsMessage extends ServerMessage {
  const AgentsMessage(this.agents);

  final List<RemoteAgent> agents;
}

class TranscriptItem {
  const TranscriptItem({
    required this.role,
    required this.text,
    this.tool,
    this.at,
  });

  final String role;
  final String text;
  final String? tool;
  final int? at;
}

class TranscriptPage extends ServerMessage {
  const TranscriptPage({
    required this.rid,
    required this.agent,
    required this.items,
    required this.before,
  });

  final String rid;
  final String agent;
  final List<TranscriptItem> items;
  final String? before;
}

class TranscriptAppend extends ServerMessage {
  const TranscriptAppend({required this.agent, required this.items});

  final String agent;
  final List<TranscriptItem> items;
}

class RequestOption {
  const RequestOption({required this.label, required this.description});

  final String label;
  final String description;
}

class RequestQuestion {
  const RequestQuestion({
    required this.question,
    required this.header,
    required this.multiSelect,
    required this.options,
  });

  final String question;
  final String header;
  final bool multiSelect;
  final List<RequestOption> options;
}

sealed class RemoteRequestBody {
  const RemoteRequestBody();
}

class PermissionRequestBody extends RemoteRequestBody {
  const PermissionRequestBody({
    required this.tool,
    required this.description,
    required this.input,
  });

  final String tool;
  final String description;
  final String input;
}

class QuestionRequestBody extends RemoteRequestBody {
  const QuestionRequestBody(this.questions);

  final List<RequestQuestion> questions;
}

class RemoteRequest {
  const RemoteRequest({
    required this.ref,
    required this.agent,
    required this.kind,
    required this.createdAt,
    required this.expiresAt,
    required this.body,
  });

  final String ref;
  final String agent;
  final String kind;
  final int createdAt;
  final int expiresAt;
  final RemoteRequestBody body;
}

class RequestsMessage extends ServerMessage {
  const RequestsMessage(this.requests);

  final List<RemoteRequest> requests;
}

class AgentStopResult extends ServerMessage {
  const AgentStopResult({required this.rid, required this.result});

  final String rid;
  final String result;
}

class AgentMessageResult extends ServerMessage {
  const AgentMessageResult({required this.rid, required this.result});

  final String rid;
  final String result;
}

class RequestAnswerResult extends ServerMessage {
  const RequestAnswerResult({required this.rid, required this.result});

  final String rid;
  final String result;
}

sealed class QuestionResponse {
  const QuestionResponse();
}

class QuestionLabels extends QuestionResponse {
  const QuestionLabels(this.labels);

  final List<String> labels;
}

class QuestionText extends QuestionResponse {
  const QuestionText(this.text);

  final String text;
}

Map<String, Object> pairRequest({
  required String secret,
  required String publicKey,
  required String name,
}) {
  if (!_pairingSecret.hasMatch(secret) ||
      !_canonicalBase64(publicKey, maximumBytes: 1024) ||
      !_validString(name, maximum: 64) ||
      _hasControlCharacter(name)) {
    throw const ProtocolException('폰 등록 정보가 올바르지 않습니다.');
  }
  return {
    'type': 'pair.request',
    'v': remoteProtocolVersion,
    'secret': secret,
    'connKey': publicKey,
    'name': name,
  };
}

Map<String, Object> authResponse({
  required String deviceId,
  required String signature,
  String? resumeToken,
}) {
  if (!_validString(deviceId, maximum: 256) ||
      !_canonicalBase64(signature, maximumBytes: 256) ||
      (resumeToken != null &&
          !RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(resumeToken))) {
    throw const ProtocolException('폰 인증 정보가 올바르지 않습니다.');
  }
  final response = <String, Object>{
    'type': 'auth.response',
    'v': remoteProtocolVersion,
    'deviceId': deviceId,
    'signature': signature,
  };
  if (resumeToken case final token?) response['resumeToken'] = token;
  return response;
}

Map<String, Object> pinSubmit(String pin) {
  if (!RegExp(r'^\d{6,32}$').hasMatch(pin)) {
    throw const ProtocolException('접속 PIN은 숫자 6자리 이상이어야 합니다.');
  }
  return {'type': 'pin.submit', 'v': remoteProtocolVersion, 'pin': pin};
}

Map<String, Object> capsGet() => const {'type': 'caps.get'};

Map<String, Object> pingRequest(String rid, {bool active = false}) => {
  'type': 'ping',
  'rid': _checkedRid(rid),
  'active': active,
};

Map<String, Object> watchRequest(String rid) => {
  'type': 'watch',
  'rid': _checkedRid(rid),
};

Map<String, Object> transcriptPageRequest({
  required String rid,
  required String agent,
  String? before,
}) {
  _checkRef(agent, '에이전트');
  if (before != null && !_cursor.hasMatch(before)) {
    throw const ProtocolException('대화 기록 커서가 올바르지 않습니다.');
  }
  return {
    'type': 'transcript.page',
    'rid': _checkedRid(rid),
    'agent': agent,
    'before': ?before,
  };
}

Map<String, Object> transcriptWatchRequest({
  required String rid,
  required String agent,
}) {
  _checkRef(agent, '에이전트');
  return {'type': 'transcript.watch', 'rid': _checkedRid(rid), 'agent': agent};
}

Map<String, Object> agentStopRequest({
  required String rid,
  required String agent,
}) {
  _checkRef(agent, '에이전트');
  return {'type': 'agent.stop', 'rid': _checkedRid(rid), 'agent': agent};
}

Map<String, Object> agentMessageRequest({
  required String rid,
  required String agent,
  required String text,
  List<String> drafts = const [],
}) {
  _checkRef(agent, '에이전트');
  if ((text.isNotEmpty && !_validString(text, maximum: 4000)) ||
      _hasMessageControlCharacter(text) ||
      drafts.length > 8 ||
      drafts.toSet().length != drafts.length ||
      drafts.any((ref) => !_hex128.hasMatch(ref)) ||
      (text.isEmpty && drafts.isEmpty)) {
    throw const ProtocolException('메시지는 1–4000자이며 줄바꿈 외 제어 문자를 포함할 수 없습니다.');
  }
  return {
    'type': 'agent.message',
    'rid': _checkedRid(rid),
    'agent': agent,
    'text': text,
    if (drafts.isNotEmpty) 'drafts': drafts,
  };
}

Map<String, Object> permissionAnswerRequest({
  required String rid,
  required String request,
  required bool allow,
}) {
  _checkRef(request, '응답 요청');
  return {
    'type': 'request.answer',
    'rid': _checkedRid(rid),
    'request': request,
    'answer': {'behavior': allow ? 'allow' : 'deny'},
  };
}

Map<String, Object> questionAnswerRequest({
  required String rid,
  required String request,
  required QuestionRequestBody body,
  required List<QuestionResponse> responses,
}) {
  _checkRef(request, '응답 요청');
  if (responses.length != body.questions.length) {
    throw const ProtocolException('모든 질문에 답해야 합니다.');
  }
  final answers = <Map<String, Object>>[];
  for (var index = 0; index < responses.length; index++) {
    final question = body.questions[index];
    final response = responses[index];
    if (response is QuestionText) {
      if (question.multiSelect || !_validString(response.text, maximum: 2000)) {
        throw const ProtocolException('직접 입력 답변이 올바르지 않습니다.');
      }
      answers.add({'text': response.text});
      continue;
    }
    if (response is! QuestionLabels) {
      throw const ProtocolException('질문 답변이 올바르지 않습니다.');
    }
    final labels = response.labels;
    final allowed = question.options.map((option) => option.label).toSet();
    final requiredCount = question.multiSelect ? 1 : 1;
    final validCount = question.multiSelect
        ? labels.length >= requiredCount
        : labels.length == requiredCount;
    if (!validCount ||
        labels.toSet().length != labels.length ||
        !labels.every(allowed.contains)) {
      throw const ProtocolException('선택한 답변이 올바르지 않습니다.');
    }
    answers.add({'labels': List<String>.unmodifiable(labels)});
  }
  return {
    'type': 'request.answer',
    'rid': _checkedRid(rid),
    'request': request,
    'answer': {'answers': answers},
  };
}

Map<String, Object> browserUserAnswerRequest({
  required String rid,
  required String request,
  required String choice,
}) {
  _checkRef(request, '응답 요청');
  if (!const {'done', 'unable'}.contains(choice)) {
    throw const ProtocolException('사람 차례 답변이 올바르지 않습니다.');
  }
  return {
    'type': 'request.answer',
    'rid': _checkedRid(rid),
    'request': request,
    'answer': {'choice': choice},
  };
}

ServerMessage parseServerMessage(String text) {
  final Object? decoded;
  try {
    decoded = jsonDecode(text);
  } on FormatException {
    throw const ProtocolException('컴퓨터가 읽을 수 없는 응답을 보냈습니다.');
  }
  if (decoded is! Map<String, dynamic>) {
    throw const ProtocolException('컴퓨터 응답 형식이 올바르지 않습니다.');
  }
  final advanced = _parseAdvancedServerMessage(decoded);
  if (advanced != null) return advanced;
  switch (decoded['type']) {
    case 'pair.pending':
      if (_hasExactKeys(decoded, {'type', 'v', 'deviceId', 'code'}) &&
          decoded['v'] == remoteProtocolVersion &&
          decoded['deviceId'] is String &&
          _hex128.hasMatch(decoded['deviceId'] as String) &&
          decoded['code'] is String &&
          _pairingCode.hasMatch(decoded['code'] as String)) {
        return PairPending(
          deviceId: decoded['deviceId'] as String,
          code: decoded['code'] as String,
        );
      }
    case 'auth.ok':
      if (_hasExactKeys(decoded, {
            'type',
            'v',
            'resumeToken',
            'pinIdleMinutes',
          }) &&
          decoded['v'] == remoteProtocolVersion &&
          decoded['resumeToken'] is String &&
          RegExp(r'^[A-Za-z0-9_-]{43}$')
              .hasMatch(decoded['resumeToken'] as String) &&
          const {10, 20, 30, 60}.contains(decoded['pinIdleMinutes'])) {
        return AuthOk(
          resumeToken: decoded['resumeToken'] as String,
          pinIdleMinutes: decoded['pinIdleMinutes'] as int,
        );
      }
    case 'pin.required':
      if (_hasExactKeys(decoded, {'type', 'v'}) &&
          decoded['v'] == remoteProtocolVersion) {
        return const PinRequired();
      }
    case 'pin.error':
      if (_hasExactKeys(decoded, {'type', 'v', 'reason', 'retryAfterMs'}) &&
          decoded['v'] == remoteProtocolVersion &&
          const {
            'incorrect',
            'retry-later',
            'unavailable',
          }.contains(decoded['reason']) &&
          decoded['retryAfterMs'] is int &&
          (decoded['retryAfterMs'] as int) >= 0 &&
          (decoded['retryAfterMs'] as int) <= 60000) {
        return PinError(
          reason: decoded['reason'] as String,
          retryAfterMs: decoded['retryAfterMs'] as int,
        );
      }
    case 'service.status':
      if (_hasExactKeys(decoded, {'type', 'v', 'reason'}) &&
          decoded['v'] == remoteProtocolVersion &&
          const {
            'pin-required',
            'sharing-disabled',
          }.contains(decoded['reason'])) {
        return ServiceStatus(decoded['reason'] as String);
      }
    case 'caps':
      if (_hasExactKeys(decoded, {
            'type',
            'remoteRpc',
            'macName',
            'requests',
          }) &&
          decoded['remoteRpc'] == remoteProtocolVersion &&
          decoded['macName'] is String &&
          _validString(decoded['macName'] as String, maximum: 64) &&
          !_hasControlCharacter(decoded['macName'] as String) &&
          decoded['requests'] is List) {
        final values = decoded['requests'] as List<dynamic>;
        if (values.every((value) => value is String && _validString(value)) &&
            values.toSet().length == values.length) {
          return Capabilities(
            macName: decoded['macName'] as String,
            requests: List<String>.unmodifiable(values.cast<String>()),
          );
        }
      }
    case 'pong':
      if (_hasExactKeys(decoded, {'type', 'rid'}) &&
          _validRid(decoded['rid'])) {
        return Pong(decoded['rid'] as String);
      }
    case 'agents':
      if (_hasExactKeys(decoded, {'type', 'agents'}) &&
          decoded['agents'] is List) {
        final agents = _parseList(decoded['agents'], _parseAgent);
        if (agents != null) return AgentsMessage(agents);
      }
    case 'requests':
      if (_hasExactKeys(decoded, {'type', 'requests'}) &&
          decoded['requests'] is List) {
        final requests = _parseList(decoded['requests'], _parseRequest);
        if (requests != null) return RequestsMessage(requests);
      }
    case 'transcript':
      if (_hasExactKeys(decoded, {'type', 'rid', 'agent', 'items', 'before'}) &&
          _validRid(decoded['rid']) &&
          _validRef(decoded['agent']) &&
          decoded['items'] is List &&
          (decoded['before'] == null ||
              (decoded['before'] is String &&
                  _hex128.hasMatch(decoded['before'] as String)))) {
        final items = _parseList(decoded['items'], _parseTranscriptItem);
        if (items != null && items.length <= 50) {
          return TranscriptPage(
            rid: decoded['rid'] as String,
            agent: decoded['agent'] as String,
            items: items,
            before: decoded['before'] as String?,
          );
        }
      }
    case 'transcript.append':
      if (_hasExactKeys(decoded, {'type', 'agent', 'items'}) &&
          _validRef(decoded['agent']) &&
          decoded['items'] is List) {
        final items = _parseList(decoded['items'], _parseTranscriptItem);
        if (items != null && items.isNotEmpty) {
          return TranscriptAppend(
            agent: decoded['agent'] as String,
            items: items,
          );
        }
      }
    case 'agent.stop.result':
      if (_hasExactKeys(decoded, {'type', 'rid', 'result'}) &&
          _validRid(decoded['rid']) &&
          const {
            'sent',
            'not-working',
            'unsupported',
          }.contains(decoded['result'])) {
        return AgentStopResult(
          rid: decoded['rid'] as String,
          result: decoded['result'] as String,
        );
      }
    case 'agent.message.result':
      if (_hasExactKeys(decoded, {'type', 'rid', 'result'}) &&
          _validRid(decoded['rid']) &&
          const {
            'delivered',
            'sent',
            'failed',
            'unsupported',
          }.contains(decoded['result'])) {
        return AgentMessageResult(
          rid: decoded['rid'] as String,
          result: decoded['result'] as String,
        );
      }
    case 'request.answer.result':
      if (_hasExactKeys(decoded, {'type', 'rid', 'result'}) &&
          _validRid(decoded['rid']) &&
          const {
            'delivered',
            'already-answered',
            'expired',
            'failed',
          }.contains(decoded['result'])) {
        return RequestAnswerResult(
          rid: decoded['rid'] as String,
          result: decoded['result'] as String,
        );
      }
    case 'error':
      if ((_hasExactKeys(decoded, {'type', 'error'}) ||
              (_hasExactKeys(decoded, {'type', 'rid', 'error'}) &&
                  _validRid(decoded['rid']))) &&
          _hasExactKeys(decoded['error'], {'code'})) {
        final error = decoded['error']! as Map<String, dynamic>;
        if (error['code'] is String && _errorCodes.contains(error['code'])) {
          return RemoteError(
            error['code'] as String,
            rid: decoded['rid'] as String?,
          );
        }
      }
  }
  throw const ProtocolException('컴퓨터 응답 형식이 올바르지 않습니다.');
}

RemoteAgent? _parseAgent(Object? value) {
  if (!_hasExactKeys(value, {
        'ref',
        'name',
        'kind',
        'status',
        'question',
        'space',
        'spaceRef',
        'spaceOrder',
        'sessionOrder',
        'parent',
        'lastActivityAt',
        'can',
      }) ||
      !_validRef((value as Map<String, dynamic>)['ref']) ||
      value['name'] is! String ||
      !_validString(value['name'] as String) ||
      !const {'claude', 'codex', 'other', 'terminal'}.contains(value['kind']) ||
      !const {
        'working',
        'idle',
        'done',
        'blocked',
        'unknown',
      }.contains(value['status']) ||
      value['question'] is! bool ||
      value['space'] is! String ||
      !_validString(value['space'] as String) ||
      !_validRef(value['spaceRef']) ||
      value['spaceOrder'] is! int ||
      (value['spaceOrder'] as int) < 0 ||
      value['sessionOrder'] is! int ||
      (value['sessionOrder'] as int) < 0 ||
      (value['parent'] != null && !_validRef(value['parent'])) ||
      (value['lastActivityAt'] != null &&
          !_validTimestamp(value['lastActivityAt'])) ||
      !_hasExactKeys(value['can'], {'stop', 'message'})) {
    return null;
  }
  final can = value['can']! as Map<String, dynamic>;
  if (can['stop'] is! bool || can['message'] is! bool) return null;
  return RemoteAgent(
    ref: value['ref'] as String,
    name: value['name'] as String,
    kind: value['kind'] as String,
    status: value['status'] as String,
    question: value['question'] as bool,
    space: value['space'] as String,
    spaceRef: value['spaceRef'] as String,
    spaceOrder: value['spaceOrder'] as int,
    sessionOrder: value['sessionOrder'] as int,
    parent: value['parent'] as String?,
    lastActivityAt: value['lastActivityAt'] as int?,
    can: AgentPermissions(
      stop: can['stop'] as bool,
      message: can['message'] as bool,
    ),
  );
}

TranscriptItem? _parseTranscriptItem(Object? value) {
  if (value is! Map<String, dynamic>) return null;
  const required = {'role', 'text'};
  const allowed = {'role', 'text', 'tool', 'at'};
  if (!value.keys.toSet().containsAll(required) ||
      !value.keys.every(allowed.contains) ||
      !const {'user', 'assistant', 'tool'}.contains(value['role']) ||
      value['text'] is! String ||
      !_validPossiblyEmptyString(value['text'] as String, maximum: 4000) ||
      (value.containsKey('tool') &&
          (value['tool'] is! String ||
              !_validString(value['tool'] as String))) ||
      (value.containsKey('at') && !_validTimestamp(value['at']))) {
    return null;
  }
  return TranscriptItem(
    role: value['role'] as String,
    text: value['text'] as String,
    tool: value['tool'] as String?,
    at: value['at'] as int?,
  );
}

RemoteRequest? _parseRequest(Object? value) {
  if (!_hasExactKeys(value, {
    'ref',
    'agent',
    'kind',
    'createdAt',
    'expiresAt',
    'body',
  })) {
    return null;
  }
  final map = value! as Map<String, dynamic>;
  if (!_validRef(map['ref']) ||
      !_validRef(map['agent']) ||
      !const {
        'claude-permission',
        'claude-question',
        'browser-user',
      }.contains(map['kind']) ||
      !_validTimestamp(map['createdAt']) ||
      !_validTimestamp(map['expiresAt']) ||
      (map['expiresAt'] as int) <= (map['createdAt'] as int)) {
    return null;
  }
  final RemoteRequestBody? body = switch (map['kind']) {
    'claude-permission' => _parsePermissionBody(map['body']),
    'claude-question' => _parseQuestionBody(map['body']),
    'browser-user' => _parseBrowserUserBody(map['body']),
    _ => null,
  };
  if (body == null) return null;
  return RemoteRequest(
    ref: map['ref'] as String,
    agent: map['agent'] as String,
    kind: map['kind'] as String,
    createdAt: map['createdAt'] as int,
    expiresAt: map['expiresAt'] as int,
    body: body,
  );
}

class BrowserUserRequestBody extends RemoteRequestBody {
  const BrowserUserRequestBody({
    required this.title,
    required this.text,
    required this.choices,
    this.tab,
  });

  final String title;
  final String text;
  final List<String> choices;
  final String? tab;
}

BrowserUserRequestBody? _parseBrowserUserBody(Object? value) {
  if (value is! Map<String, dynamic>) return null;
  final keys = value.keys.toSet();
  if (!keys.containsAll({'title', 'text', 'choices'}) ||
      !keys.every({'title', 'text', 'choices', 'tab'}.contains) ||
      value['title'] is! String ||
      !_validString(value['title'] as String, maximum: 60) ||
      value['text'] is! String ||
      !_validString(value['text'] as String, maximum: 500) ||
      value['choices'] is! List ||
      (value['choices'] as List).length != 2 ||
      !(value['choices'] as List).every(
        (choice) => choice is String && _validString(choice, maximum: 20),
      ) ||
      (value.containsKey('tab') && !_validRef(value['tab']))) {
    return null;
  }
  return BrowserUserRequestBody(
    title: value['title'] as String,
    text: value['text'] as String,
    choices: List<String>.unmodifiable((value['choices'] as List).cast()),
    tab: value['tab'] as String?,
  );
}

PermissionRequestBody? _parsePermissionBody(Object? value) {
  if (!_hasExactKeys(value, {'tool', 'description', 'input'})) return null;
  final map = value! as Map<String, dynamic>;
  if (map['tool'] is! String ||
      !_validString(map['tool'] as String) ||
      map['description'] is! String ||
      !_validPossiblyEmptyString(map['description'] as String) ||
      map['input'] is! String ||
      !_validPossiblyEmptyString(map['input'] as String)) {
    return null;
  }
  return PermissionRequestBody(
    tool: map['tool'] as String,
    description: map['description'] as String,
    input: map['input'] as String,
  );
}

QuestionRequestBody? _parseQuestionBody(Object? value) {
  if (!_hasExactKeys(value, {'questions'})) return null;
  final questionsValue = (value! as Map<String, dynamic>)['questions'];
  if (questionsValue is! List || questionsValue.isEmpty) return null;
  final questions = _parseList(questionsValue, _parseQuestion);
  return questions == null ? null : QuestionRequestBody(questions);
}

RequestQuestion? _parseQuestion(Object? value) {
  if (!_hasExactKeys(value, {'question', 'header', 'multiSelect', 'options'})) {
    return null;
  }
  final map = value! as Map<String, dynamic>;
  if (map['question'] is! String ||
      !_validString(map['question'] as String) ||
      map['header'] is! String ||
      !_validString(map['header'] as String) ||
      map['multiSelect'] is! bool ||
      map['options'] is! List ||
      (map['options'] as List).isEmpty) {
    return null;
  }
  final options = _parseList(map['options'], _parseOption);
  if (options == null) return null;
  return RequestQuestion(
    question: map['question'] as String,
    header: map['header'] as String,
    multiSelect: map['multiSelect'] as bool,
    options: options,
  );
}

RequestOption? _parseOption(Object? value) {
  if (!_hasExactKeys(value, {'label', 'description'})) return null;
  final map = value! as Map<String, dynamic>;
  if (map['label'] is! String ||
      !_validString(map['label'] as String) ||
      map['description'] is! String ||
      !_validPossiblyEmptyString(map['description'] as String)) {
    return null;
  }
  return RequestOption(
    label: map['label'] as String,
    description: map['description'] as String,
  );
}

List<T>? _parseList<T>(Object? value, T? Function(Object?) parse) {
  if (value is! List) return null;
  final result = <T>[];
  for (final item in value) {
    final parsed = parse(item);
    if (parsed == null) return null;
    result.add(parsed);
  }
  return List<T>.unmodifiable(result);
}

String _checkedRid(String value) {
  if (!_rid.hasMatch(value)) {
    throw const ProtocolException('요청 번호가 올바르지 않습니다.');
  }
  return value;
}

void _checkRef(String value, String name) {
  if (!_hex128.hasMatch(value)) {
    throw ProtocolException('$name 정보가 올바르지 않습니다.');
  }
}

bool _validRid(Object? value) => value is String && _rid.hasMatch(value);

bool _validRef(Object? value) => value is String && _hex128.hasMatch(value);

bool _validTimestamp(Object? value) =>
    value is int && value >= 0 && value <= 9007199254740991;

Uint8List canonicalJsonBytes(Object? value) =>
    Uint8List.fromList(utf8.encode(canonicalJson(value)));

String canonicalJson(Object? value) => _canonical(value, <Object>{});

String _canonical(Object? value, Set<Object> parents) {
  if (value == null || value is bool || value is String) {
    if (value is String) _validateUnicode(value);
    return jsonEncode(value);
  }
  if (value is num) {
    if (!value.isFinite) {
      throw const ProtocolException('유한한 숫자만 JCS로 만들 수 있습니다.');
    }
    if (value is int) {
      if (value < -9007199254740991 || value > 9007199254740991) {
        throw const ProtocolException('JCS 숫자 범위를 벗어났습니다.');
      }
      return value.toString();
    }
    if (value == 0) return '0';
    final encoded = value.toString();
    return encoded.endsWith('.0')
        ? encoded.substring(0, encoded.length - 2)
        : encoded;
  }
  if (value is! List && value is! Map<String, Object?>) {
    throw const ProtocolException('JSON 값만 JCS로 만들 수 있습니다.');
  }
  if (!parents.add(value)) {
    throw const ProtocolException('순환 객체는 JCS로 만들 수 없습니다.');
  }
  try {
    if (value is List) {
      return '[${value.map((item) => _canonical(item, parents)).join(',')}]';
    }
    final map = value as Map<String, Object?>;
    final keys = map.keys.toList()..sort(_compareUtf16);
    return '{${keys.map((key) {
      _validateUnicode(key);
      return '${jsonEncode(key)}:${_canonical(map[key], parents)}';
    }).join(',')}}';
  } finally {
    parents.remove(value);
  }
}

int _compareUtf16(String left, String right) {
  final leftUnits = left.codeUnits;
  final rightUnits = right.codeUnits;
  final common = leftUnits.length < rightUnits.length
      ? leftUnits.length
      : rightUnits.length;
  for (var index = 0; index < common; index++) {
    final result = leftUnits[index].compareTo(rightUnits[index]);
    if (result != 0) return result;
  }
  return leftUnits.length.compareTo(rightUnits.length);
}

void _validateUnicode(String value) {
  final units = value.codeUnits;
  for (var index = 0; index < units.length; index++) {
    final unit = units[index];
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (++index >= units.length ||
          units[index] < 0xdc00 ||
          units[index] > 0xdfff) {
        throw const ProtocolException('짝이 없는 UTF-16 문자는 사용할 수 없습니다.');
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw const ProtocolException('짝이 없는 UTF-16 문자는 사용할 수 없습니다.');
    }
  }
}

bool _hasExactKeys(Object? value, Set<String> keys) {
  return value is Map<String, dynamic> &&
      value.length == keys.length &&
      value.keys.every(keys.contains);
}

bool _hasKeys(Object? value, Set<String> keys) {
  if (value is! Map) return false;
  return keys.every(value.containsKey);
}

bool _isIpv4(String value) {
  final parts = value.split('.');
  return parts.length == 4 &&
      parts.every((part) {
        if (part.isEmpty ||
            (part.length > 1 && part.startsWith('0')) ||
            !RegExp(r'^\d{1,3}$').hasMatch(part)) {
          return false;
        }
        final number = int.parse(part);
        return number >= 0 && number <= 255;
      });
}

bool _validString(String value, {int maximum = 0x7fffffffffffffff}) {
  if (value.isEmpty || value.length > maximum) return false;
  return _validPossiblyEmptyString(value, maximum: maximum);
}

bool _validPossiblyEmptyString(
  String value, {
  int maximum = 0x7fffffffffffffff,
}) {
  if (value.length > maximum) return false;
  try {
    _validateUnicode(value);
    return true;
  } on ProtocolException {
    return false;
  }
}

bool _hasControlCharacter(String value) =>
    value.runes.any((rune) => rune <= 0x1f || (rune >= 0x7f && rune <= 0x9f));

bool _hasMessageControlCharacter(String value) => value.runes.any(
  (rune) =>
      (rune <= 0x1f && rune != 0x0a && rune != 0x0d) ||
      (rune >= 0x7f && rune <= 0x9f),
);

bool _canonicalBase64(String value, {required int maximumBytes}) {
  if (value.isEmpty || value.length > ((maximumBytes + 2) ~/ 3) * 4) {
    return false;
  }
  try {
    final bytes = base64Decode(value);
    return bytes.isNotEmpty &&
        bytes.length <= maximumBytes &&
        base64Encode(bytes) == value;
  } on FormatException {
    return false;
  }
}
