// 터미널 화면에서 읽은 질문·선택지 문구 가공. 표시용이며 서버로 보내는 값은 바꾸지 않음

// 질문 본문의 제목과 보조 설명
class QuestionText {
  const QuestionText(this.title, this.body);
  final String title;
  final String body;
}

// 선택지 표시용 문구
class OptionText {
  const OptionText(
    this.label, {
    this.recommended = false,
    this.previous = false,
    this.description = '',
  });
  final String label;
  // 끝의 (Recommended)
  final bool recommended;
  // 끝의 ✔, 이미 답한 질문으로 돌아왔을 때 이전 선택 줄
  final bool previous;
  final String description;
}

final _sentenceEnd = RegExp(r'[.!?？！。]$');
final _listStart = RegExp(r'^(?:[-•*·]\s|\d+[.)]\s)');

// 터미널 폭 때문에 생긴 줄바꿈 이음. 빈 줄은 문단 구분
// 줄 끝이 문장부호·콜론이거나 다음 줄이 목록·들여쓰기로 시작하면 줄바꿈 유지
// 이음 자리는 공백 한 칸: 터미널은 단어 사이 공백에서 줄을 바꾸고 그 공백을 지움
String joinWrappedLines(String raw) {
  final lines = raw.replaceAll('\r\n', '\n').split('\n');
  final indents = [
    for (final line in lines)
      if (line.trim().isNotEmpty) line.length - line.trimLeft().length,
  ];
  final base = indents.isEmpty ? 0 : indents.reduce((a, b) => a < b ? a : b);
  final paragraphs = <List<String>>[];
  var current = <String>[];
  var previous = '';
  for (final line in lines) {
    final text = line.trimRight();
    if (text.trim().isEmpty) {
      if (current.isNotEmpty) paragraphs.add(current);
      current = [];
      continue;
    }
    final indent = text.length - text.trimLeft().length - base;
    final body = text.trimLeft();
    if (current.isEmpty) {
      current.add(body);
    } else if (_keepsBreak(previous, body, indent)) {
      current.add(body);
    } else {
      current[current.length - 1] = '${current.last} $body';
    }
    previous = body;
  }
  if (current.isNotEmpty) paragraphs.add(current);
  return paragraphs.map((p) => p.join('\n')).join('\n\n');
}

bool _keepsBreak(String previous, String next, int indent) =>
    indent > 0 ||
    _listStart.hasMatch(next) ||
    _sentenceEnd.hasMatch(_stripClosers(previous)) ||
    _stripClosers(previous).endsWith(':') ||
    _stripClosers(previous).endsWith('：');

// 문장부호 뒤에 붙은 닫는 따옴표·괄호는 무시하고 판정
String _stripClosers(String text) =>
    text.replaceFirst(RegExp('''[)\\]"'”’」』]+\$'''), '');

// 줄바꿈을 모두 이어 한 문단으로. 선택지 설명용
String joinParagraph(String raw) => raw
    .split(RegExp(r'\s*\n\s*'))
    .map((line) => line.trim())
    .where((line) => line.isNotEmpty)
    .join(' ');

// 에이전트가 고정 문구로 묻는 승인 제목의 한글 표시. 목록에 없는 문구는 원문 유지
final _approvalTitles = <(RegExp, String Function(RegExpMatch))>[
  (
    RegExp(r'^do you want to proceed\?$', caseSensitive: false),
    (_) => '진행할까요?',
  ),
  (
    RegExp(r'^do you want to make this edit to (.+)\?$', caseSensitive: false),
    (m) => '${m[1]} 수정을 허용할까요?',
  ),
  (
    RegExp(r'^do you want to create (.+)\?$', caseSensitive: false),
    (m) => '${m[1]}을(를) 만들도록 허용할까요?',
  ),
  (
    RegExp(
      r'^do you want to allow claude to fetch this content\?$',
      caseSensitive: false,
    ),
    (_) => '이 내용을 가져오도록 허용할까요?',
  ),
  (
    RegExp(
      r'^would you like to run the following command\?$',
      caseSensitive: false,
    ),
    (_) => '다음 명령을 실행할까요?',
  ),
  (
    RegExp(
      r'^would you like to make the following edits\?$',
      caseSensitive: false,
    ),
    (_) => '다음 수정을 적용할까요?',
  ),
  (
    RegExp(r'^implement this plan\?$', caseSensitive: false),
    (_) => '이 계획으로 구현할까요?',
  ),
  (
    RegExp(
      r'^claude has written up a plan and is ready to execute\. would you like to proceed\?$',
      caseSensitive: false,
    ),
    (_) => '계획이 준비되었습니다. 진행할까요?',
  ),
];

String _approvalTitle(String text) {
  final value = text.trim();
  for (final (pattern, build) in _approvalTitles) {
    final match = pattern.firstMatch(value);
    if (match != null) return build(match);
  }
  return text;
}

// 승인 훅이 알려 준 도구 이름·대상으로 만든 제목. 화면 문구가 바뀌어도 같은 제목, 모르는 도구도 이름으로 표시
QuestionText toolApprovalText(String tool, String target) =>
    QuestionText(_toolApprovalTitle(tool, target), '');

String _toolApprovalTitle(String tool, String target) {
  String on(String suffix, String generic) =>
      target.isEmpty ? generic : '$target $suffix';
  if (tool.startsWith('mcp__')) {
    final parts = tool.split('__');
    return parts.length >= 3
        ? '${parts[1]}의 ${parts.sublist(2).join('__')} 도구를 사용할까요?'
        : '$tool 도구를 사용할까요?';
  }
  return switch (tool) {
    'Bash' || 'PowerShell' => '다음 명령을 실행할까요?',
    'Edit' || 'MultiEdit' => on('수정을 허용할까요?', '파일 수정을 허용할까요?'),
    'Write' => on('쓰기를 허용할까요?', '파일 쓰기를 허용할까요?'),
    'NotebookEdit' => on('노트북 수정을 허용할까요?', '노트북 수정을 허용할까요?'),
    'Read' || 'Glob' || 'Grep' => on('읽기를 허용할까요?', '파일 읽기를 허용할까요?'),
    'WebFetch' => '이 내용을 가져오도록 허용할까요?',
    'WebSearch' => '웹 검색을 허용할까요?',
    'ExitPlanMode' => '계획이 준비되었습니다. 진행할까요?',
    _ => '$tool 사용을 허용할까요?',
  };
}

// 질문 본문을 제목과 보조 설명으로 나눔
// 제목은 물음표로 끝나는 첫 문장, 없으면 첫 문장. 따옴표·백틱 안에서는 문장을 나누지 않음
QuestionText formatQuestion(String raw) {
  final text = joinWrappedLines(raw).trim();
  if (text.isEmpty) return const QuestionText('', '');
  final fixedTitle = _approvalTitle(text);
  if (fixedTitle != text) return QuestionText(fixedTitle, '');
  final units = _sentences(text);
  var at = units.indexWhere((u) => RegExp(r'[?？]$').hasMatch(u.text));
  // 물음표 문장이 없으면 요청형(…주세요·…하세요)으로 끝나는 마지막 문장이 제목, 아니면 첫 문장
  if (at < 0) {
    final asks = RegExp(r'(?:세요|십시오|바랍니다)[.!]?$');
    at = asks.hasMatch(units.last.text) ? units.length - 1 : 0;
  }
  final title = units[at].text;
  final rest = [...units]..removeAt(at);
  final body = StringBuffer();
  for (var i = 0; i < rest.length; i++) {
    if (i > 0) body.write(rest[i].separator);
    body.write(rest[i].text);
  }
  return QuestionText(title, body.toString().trim());
}

class _Unit {
  const _Unit(this.separator, this.text);
  // 앞 문장과의 사이: 공백 · 줄바꿈 · 빈 줄
  final String separator;
  final String text;
}

List<_Unit> _sentences(String text) {
  final out = <_Unit>[];
  final buffer = StringBuffer();
  var separator = '';
  var quote = '';
  void flush(String next) {
    final value = buffer.toString().trim();
    buffer.clear();
    if (value.isNotEmpty) out.add(_Unit(out.isEmpty ? '' : separator, value));
    separator = next;
  }

  const closers = {'‘': '’', '“': '”', '「': '」', '『': '』', '`': '`', '"': '"'};
  final chars = text.runes.map(String.fromCharCode).toList();
  for (var i = 0; i < chars.length; i++) {
    final c = chars[i];
    if (quote.isNotEmpty) {
      if (c == quote) quote = '';
    } else if (c == "'") {
      final before = i > 0 ? chars[i - 1] : '';
      final after = i + 1 < chars.length ? chars[i + 1] : '';
      final apostrophe =
          RegExp(r'[A-Za-z]').hasMatch(before) &&
          RegExp(r'[A-Za-z]').hasMatch(after);
      if (!apostrophe) quote = "'";
    } else if (closers.containsKey(c)) {
      quote = closers[c]!;
    }
    if (quote.isEmpty && c == '\n') {
      var n = 1;
      while (i + n < chars.length && chars[i + n] == '\n') {
        n++;
      }
      flush(n > 1 ? '\n\n' : '\n');
      i += n - 1;
      continue;
    }
    buffer.write(c);
    if (quote.isEmpty && '.!?？！。'.contains(c)) {
      final next = i + 1 < chars.length ? chars[i + 1] : '';
      final numbering = RegExp(r'^\d+\.$').hasMatch(buffer.toString().trim());
      if ((next == ' ' || next.isEmpty) && !numbering) {
        flush(' ');
      }
    }
  }
  flush('');
  return out;
}

// 터미널 고정 영어 문구의 한글 표시. 목록에 없는 문구는 원문 유지
const _fixed = {
  'type something': '직접 입력',
  'type your own': '직접 입력',
  'chat about this': '이 내용으로 대화하기',
  'submit answers': '답변 제출',
  'submit': '제출',
  'next': '다음',
  'cancel': '취소',
};

String _fixedLabel(String label) {
  final key = label.toLowerCase().replaceFirst(RegExp(r'[.…\s]+$'), '').trim();
  return _fixed[key] ?? label;
}

// 에이전트가 고정 문구로 보여 주는 승인 선택지의 한글 표시. 목록에 없는 문구는 원문 유지
final _approvalLabels = <(RegExp, String Function(RegExpMatch))>[
  (RegExp(r'^yes$', caseSensitive: false), (_) => '예'),
  (RegExp(r'^no$', caseSensitive: false), (_) => '아니요'),
  (RegExp(r'^yes, proceed$', caseSensitive: false), (_) => '예, 진행'),
  (
    RegExp(
      r"^yes, and don.t ask again for commands that start with (.+)$",
      caseSensitive: false,
    ),
    (m) => '예, 이 명령으로 시작하는 명령은 다시 묻지 않기: ${m[1]}',
  ),
  (
    RegExp(r"^yes, and don.t ask again for these files$", caseSensitive: false),
    (_) => '예, 이 파일은 다시 묻지 않기',
  ),
  (
    RegExp(r"^yes, and don.t ask again for (.+)$", caseSensitive: false),
    (m) => '예, ${m[1]}은(는) 다시 묻지 않기',
  ),
  (
    RegExp(
      r'^yes, and always allow access to (.+?) from this project$',
      caseSensitive: false,
    ),
    (m) => '예, 이 프로젝트에서 항상 허용: ${m[1]}',
  ),
  (
    RegExp(r'^yes, and switch to accept edits\b.*$', caseSensitive: false),
    (_) => '예, 편집 자동 수락으로 전환',
  ),
  (
    RegExp(r'^yes, and (?:switch to|use) auto mode\b.*$', caseSensitive: false),
    (_) => '예, 자동 모드로 전환',
  ),
  (
    RegExp(
      r'^yes, allow reading from (.+?) from this project$',
      caseSensitive: false,
    ),
    (m) => '예, 이 프로젝트에서 읽기 허용: ${m[1]}',
  ),
  (
    RegExp(
      r'^yes, allow reading from (.+?) during this session$',
      caseSensitive: false,
    ),
    (m) => '예, 이 세션 동안 읽기 허용: ${m[1]}',
  ),
  (
    RegExp(r'^yes, allow all edits during this session$', caseSensitive: false),
    (_) => '예, 이 세션의 모든 편집 허용',
  ),
  (
    RegExp(
      r"^yes, and don.t ask again for (.+?) commands in (.+)$",
      caseSensitive: false,
    ),
    (m) => '예, ${m[2]}에서 ${m[1]} 명령은 다시 묻지 않기',
  ),
  (
    RegExp(r'^yes, manually approve edits$', caseSensitive: false),
    (_) => '예, 편집을 직접 승인',
  ),
  (
    RegExp(
      r'^no, and tell (?:claude|codex) what to do differently$',
      caseSensitive: false,
    ),
    (_) => '아니요, 다르게 할 일 알리기',
  ),
  (
    RegExp(r'^tell claude what to change$', caseSensitive: false),
    (_) => '수정할 점 알리기',
  ),
  (
    RegExp(r'^yes, implement this plan$', caseSensitive: false),
    (_) => '예, 이 계획으로 구현',
  ),
  (
    RegExp(r'^yes, clear context and implement$', caseSensitive: false),
    (_) => '예, 컨텍스트를 비우고 구현',
  ),
  (
    RegExp(r'^no, stay in plan mode$', caseSensitive: false),
    (_) => '아니요, 계획 모드 유지',
  ),
  (RegExp(r'^none of the above$', caseSensitive: false), (_) => '해당 없음'),
  (
    RegExp(r'^allow this request and continue$', caseSensitive: false),
    (_) => '이 요청 허용',
  ),
  (
    RegExp(r'^allow for this session$', caseSensitive: false),
    (_) => '이 세션 동안 허용',
  ),
  (RegExp(r'^always allow$', caseSensitive: false), (_) => '항상 허용'),
  (
    RegExp(r'^decline this request and continue$', caseSensitive: false),
    (_) => '이 요청 거절',
  ),
  (RegExp(r'^cancel this tool call$', caseSensitive: false), (_) => '도구 호출 취소'),
];

String _approvalLabel(String label) {
  for (final (pattern, build) in _approvalLabels) {
    final match = pattern.firstMatch(label);
    if (match != null) return build(match);
  }
  return label;
}

// 선택지 아래 설명의 고정 영어 문구
String _fixedDescription(String text) {
  final value = text.trim();
  const exact = {
    'Optionally, add details in notes (tab)': '필요하면 메모를 추가할 수 있습니다.',
    'Switch to Default and start coding': '기본 모드로 바꾸고 코딩을 시작합니다.',
    'Continue planning with the model': '계속 계획합니다.',
  };
  final hit = exact[value];
  if (hit != null) return hit;
  final fresh = RegExp(
    r'^Start a fresh thread(?: \(current context: (\d+)% used\))?$',
  ).firstMatch(value);
  if (fresh != null) {
    return fresh[1] == null
        ? '새 대화로 시작합니다.'
        : '새 대화로 시작합니다. (컨텍스트 ${fresh[1]}% 사용 중)';
  }
  return text;
}

// 앞의 ❯·번호·불릿·체크 표시 제거 후 끝의 (Recommended)·✔ 분리
OptionText formatOption(String text, {String description = ''}) {
  var label = text
      .replaceFirst(RegExp(r'^\s*(?:[›❯●○]\s*)?(?:\d+[.)]\s*)?'), '')
      .replaceFirst(RegExp(r'^(?:[-•*·]\s+)'), '')
      .replaceFirst(RegExp(r'^\[[ xX✔✓]?\]\s*|^[☐☒☑]\s*'), '')
      .trim();
  // 끝의 단축키 안내 (y)·(p)·(a)·(esc)·(shift+tab)
  label = label
      .replaceFirst(
        RegExp(r'\s*\((?:y|p|a|esc|tab|shift\+tab)\)$', caseSensitive: false),
        '',
      )
      .trim();
  var previous = false;
  if (RegExp(r'\s*[✔✓]$').hasMatch(label)) {
    previous = true;
    label = label.replaceFirst(RegExp(r'\s*[✔✓]$'), '').trim();
  }
  var recommended = false;
  final recommendedEnd = RegExp(r'\s*\(recommended\)$', caseSensitive: false);
  if (recommendedEnd.hasMatch(label)) {
    recommended = true;
    label = label.replaceFirst(recommendedEnd, '').trim();
  }
  return OptionText(
    _approvalLabel(_fixedLabel(label)),
    recommended: recommended,
    previous: previous,
    description: _fixedDescription(joinParagraph(description)),
  );
}
