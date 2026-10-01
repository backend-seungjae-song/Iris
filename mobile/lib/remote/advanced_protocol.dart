part of 'protocol.dart';

class KeyModifiers {
  const KeyModifiers({
    this.ctrl = false,
    this.alt = false,
    this.shift = false,
    this.cmd = false,
  });

  final bool ctrl;
  final bool alt;
  final bool shift;
  final bool cmd;

  Map<String, Object> toJson() => {
    'ctrl': ctrl,
    'alt': alt,
    'shift': shift,
    'cmd': cmd,
  };
}

class TerminalKeyButton {
  const TerminalKeyButton({
    required this.id,
    required this.label,
    required this.key,
    required this.modifiers,
  });

  final String id;
  final String label;
  final String key;
  final KeyModifiers modifiers;

  Map<String, Object> toJson() => {
    'id': id,
    'label': label,
    'key': key,
    'modifiers': modifiers.toJson(),
  };
}

class MacShortcut {
  const MacShortcut({
    required this.id,
    required this.label,
    required this.keys,
  });

  final String id;
  final String label;
  final String keys;
}

class RemoteActionResult extends ServerMessage {
  const RemoteActionResult({required this.rid, required this.result, this.tab});

  final String rid;
  final String result;
  final String? tab;
}

class TerminalWatchResult extends ServerMessage {
  const TerminalWatchResult({
    required this.rid,
    required this.agent,
    required this.revision,
    required this.text,
    required this.truncated,
    this.hash,
    this.columns,
    this.rows,
    this.mouseMode = false,
    this.error,
  });

  final String rid;
  final String agent;
  final int revision;
  final String text;
  final bool truncated;
  final String? hash;
  final int? columns;
  final int? rows;
  final bool mouseMode;
  final String? error;
}

class TerminalFrame extends ServerMessage {
  const TerminalFrame({
    required this.agent,
    required this.revision,
    required this.text,
    required this.truncated,
    this.hash,
    this.columns,
    this.rows,
    this.mouseMode = false,
    this.error,
  });

  final String agent;
  final int revision;
  final String text;
  final bool truncated;
  final String? hash;
  final int? columns;
  final int? rows;
  final bool mouseMode;
  final String? error;
}

Map<String, Object> terminalSelectRequest({
  required String rid,
  required String agent,
  required String hash,
  required int columns,
  required int rows,
  required int row,
}) => {
  'type': 'terminal.select',
  'rid': _checkedRid(rid),
  'agent': agent,
  'hash': hash,
  'columns': columns,
  'rows': rows,
  'row': row,
};

Map<String, Object> terminalMouseRequest({
  required String rid,
  required String agent,
  required String hash,
  required int columns,
  required int rows,
  required int column,
  required int row,
  required String action,
  int? dy,
}) => {
  'type': 'terminal.mouse',
  'rid': _checkedRid(rid),
  'agent': agent,
  'hash': hash,
  'columns': columns,
  'rows': rows,
  'column': column,
  'row': row,
  'action': action,
  'dy': ?dy,
};

class TerminalScrollback extends ServerMessage {
  const TerminalScrollback({
    required this.rid,
    required this.agent,
    required this.text,
    required this.columns,
    required this.lineCount,
  });
  final String rid, agent, text;
  final int columns, lineCount;
}

class TerminalKeys extends ServerMessage {
  const TerminalKeys({
    required this.rid,
    required this.keys,
    required this.defaults,
    required this.macShortcuts,
  });

  final String rid;
  final List<TerminalKeyButton> keys;
  final List<TerminalKeyButton> defaults;
  final List<MacShortcut> macShortcuts;
}

class BrowserSpace {
  const BrowserSpace({required this.ref, required this.name});

  final String ref;
  final String name;
}

class BrowserTabGroupInfo {
  const BrowserTabGroupInfo({
    required this.ref,
    required this.space,
    required this.name,
    required this.collapsed,
    this.color,
  });
  final String ref, space, name;
  final bool collapsed;
  final String? color;
}

class BrowserTab {
  const BrowserTab({
    required this.ref,
    required this.space,
    required this.title,
    required this.url,
    required this.profile,
    required this.aiControlled,
    required this.controlling,
    this.sessions = const [],
    this.group,
    required this.active,
    required this.sleeping,
  });

  final String ref;
  final String space;
  final String title;
  final String url;
  final String profile;
  final bool aiControlled;
  final List<String> controlling;
  final List<String> sessions;
  final String? group;
  final bool active;
  final bool sleeping;
}

class BrowserTabsResult extends ServerMessage {
  const BrowserTabsResult({
    required this.rid,
    required this.spaces,
    required this.groups,
    required this.tabs,
  });

  final String rid;
  final List<BrowserSpace> spaces;
  final List<BrowserTabGroupInfo> groups;
  final List<BrowserTab> tabs;
}

class BrowserFrameWatchResult extends ServerMessage {
  const BrowserFrameWatchResult({required this.rid, required this.tab});

  final String rid;
  final String tab;
}

class BrowserFrame extends ServerMessage {
  const BrowserFrame({
    required this.tab,
    required this.seq,
    required this.width,
    required this.height,
    required this.jpeg,
  });

  final String tab;
  final int seq;
  final int width;
  final int height;
  final Uint8List jpeg;
}

class BrowserElementRect {
  const BrowserElementRect({
    required this.x,
    required this.y,
    required this.width,
    required this.height,
  });

  final double x;
  final double y;
  final double width;
  final double height;
}

class BrowserElement {
  const BrowserElement({
    required this.selector,
    required this.text,
    required this.rect,
  });

  final String selector;
  final String text;
  final BrowserElementRect rect;
}

class BrowserElementResult extends ServerMessage {
  const BrowserElementResult({required this.rid, required this.element});

  final String rid;
  final BrowserElement? element;
}

class BrowserViewport {
  const BrowserViewport({required this.width, required this.height});

  final double width;
  final double height;
}

class BrowserElementHoverResult extends ServerMessage {
  const BrowserElementHoverResult({
    required this.rid,
    required this.viewport,
    required this.element,
  });

  final String rid;
  final BrowserViewport viewport;
  final BrowserElement? element;
}

class BrowserFocusResult extends ServerMessage {
  const BrowserFocusResult({
    required this.rid,
    required this.editable,
    required this.kind,
    required this.multiline,
    required this.selectedText,
  });

  final String rid;
  final bool editable;
  final String kind;
  final bool multiline;
  final String selectedText;
}

class BrowserDialog {
  const BrowserDialog({required this.kind, required this.message});

  final String kind;
  final String message;
}

class BrowserDialogResult extends ServerMessage {
  const BrowserDialogResult({required this.rid, required this.dialog});

  final String rid;
  final BrowserDialog? dialog;
}

class BrowserRecordResult extends ServerMessage {
  const BrowserRecordResult({
    required this.rid,
    required this.state,
    required this.steps,
    required this.elapsedMs,
  });

  final String rid;
  final String state;
  final List<String> steps;
  final int elapsedMs;
}

class BrowserDraftResult extends ServerMessage {
  const BrowserDraftResult({
    required this.rid,
    required this.ref,
    required this.kind,
    required this.summary,
    required this.content,
  });

  final String rid;
  final String ref;
  final String kind;
  final String summary;
  final String content;
}

class BrowserProfilesResult extends ServerMessage {
  const BrowserProfilesResult({required this.rid, required this.profiles});

  final String rid;
  final List<String> profiles;
}

class BrowserBookmark {
  const BrowserBookmark({required this.title, required this.url, this.folder});

  final String title;
  final String url;
  final String? folder;
}

class BrowserBookmarksResult extends ServerMessage {
  const BrowserBookmarksResult({required this.rid, required this.bookmarks});

  final String rid;
  final List<BrowserBookmark> bookmarks;
}

class GitFileChange {
  const GitFileChange({
    required this.ref,
    required this.path,
    required this.code,
    required this.staged,
    required this.untracked,
    required this.additions,
    required this.deletions,
  });

  final String ref;
  final String path;
  final String code;
  final bool staged;
  final bool untracked;
  final int? additions;
  final int? deletions;
}

class GitChangesResult extends ServerMessage {
  const GitChangesResult({
    required this.rid,
    required this.branch,
    required this.ahead,
    required this.behind,
    required this.base,
    required this.commitCount,
    required this.additions,
    required this.deletions,
    required this.files,
    required this.bases,
  });

  final String rid;
  final String branch;
  final int ahead;
  final int behind;
  final String base;
  final int? commitCount;
  final int? additions;
  final int? deletions;
  final List<GitFileChange> files;
  final List<String> bases;
}

class GitDiffResult extends ServerMessage {
  const GitDiffResult({
    required this.rid,
    required this.file,
    required this.patch,
    required this.truncated,
  });

  final String rid;
  final String file;
  final String patch;
  final bool truncated;
}

class GitHubReviewComment {
  const GitHubReviewComment({
    required this.author,
    required this.body,
    required this.path,
    this.line,
  });

  final String author;
  final String body;
  final String path;
  final int? line;
}

class GitHubCheck {
  const GitHubCheck({
    required this.name,
    required this.conclusion,
    required this.status,
    required this.detailsUrl,
    this.runId,
  });

  final String name;
  final String conclusion;
  final String status;
  final String detailsUrl;
  final String? runId;

  bool get failed => const {
    'failure',
    'cancelled',
    'timed_out',
    'action_required',
  }.contains(conclusion);
}

class GitHubPullRequest {
  const GitHubPullRequest({
    required this.number,
    required this.title,
    required this.state,
    required this.isDraft,
    required this.head,
    required this.base,
    required this.author,
    required this.reviewComments,
    required this.checks,
  });

  final int number;
  final String title;
  final String state;
  final bool isDraft;
  final String head;
  final String base;
  final String author;
  final List<GitHubReviewComment> reviewComments;
  final List<GitHubCheck> checks;
}

class GitHubPrResult extends ServerMessage {
  const GitHubPrResult({required this.rid, required this.pr});

  final String rid;
  final GitHubPullRequest pr;
}

class GitHubCheckLogResult extends ServerMessage {
  const GitHubCheckLogResult({
    required this.rid,
    required this.run,
    required this.log,
    required this.truncated,
  });

  final String rid;
  final String run;
  final String log;
  final bool truncated;
}

Map<String, Object> terminalWatchRequest({
  required String rid,
  required String agent,
}) {
  _checkRef(agent, '에이전트');
  return {'type': 'terminal.watch', 'rid': _checkedRid(rid), 'agent': agent};
}

Map<String, Object> terminalInputRequest({
  required String rid,
  required String agent,
  required String text,
}) {
  _checkRef(agent, '에이전트');
  _checkAdvancedText(text, 4000, '터미널 입력', allowNewlines: true, allowTab: true);
  return {
    'type': 'terminal.input',
    'rid': _checkedRid(rid),
    'agent': agent,
    'text': text,
  };
}

Map<String, Object> terminalKeyRequest({
  required String rid,
  required String agent,
  required String key,
  required KeyModifiers modifiers,
}) {
  _checkRef(agent, '에이전트');
  _checkKey(key);
  return {
    'type': 'terminal.key',
    'rid': _checkedRid(rid),
    'agent': agent,
    'key': key,
    'modifiers': modifiers.toJson(),
  };
}

Map<String, Object> terminalKeysGetRequest(String rid) => {
  'type': 'terminal.keys.get',
  'rid': _checkedRid(rid),
};

Map<String, Object> terminalKeysSetRequest({
  required String rid,
  required List<TerminalKeyButton> keys,
}) {
  if (keys.length > 24 ||
      keys.map((key) => key.id).toSet().length != keys.length) {
    throw const ProtocolException('터미널 키는 중복 없이 24개까지 저장할 수 있습니다.');
  }
  for (final button in keys) {
    if (!RegExp(r'^[A-Za-z0-9_-]{1,32}$').hasMatch(button.id)) {
      throw const ProtocolException('터미널 키 번호가 올바르지 않습니다.');
    }
    _checkAdvancedText(button.label, 24, '터미널 키 이름');
    _checkKey(button.key);
  }
  return {
    'type': 'terminal.keys.set',
    'rid': _checkedRid(rid),
    'keys': keys.map((key) => key.toJson()).toList(),
  };
}

Map<String, Object> browserTabsRequest(String rid) => {
  'type': 'browser.tabs',
  'rid': _checkedRid(rid),
};

int browserFrameRequestWidth({
  required double logicalWidth,
  required double devicePixelRatio,
  required double zoom,
  required bool desktop,
}) {
  if (!logicalWidth.isFinite ||
      !devicePixelRatio.isFinite ||
      !zoom.isFinite ||
      logicalWidth <= 0 ||
      devicePixelRatio <= 0 ||
      zoom < 1) {
    throw const ProtocolException('브라우저 화면 크기가 올바르지 않습니다.');
  }
  var width = (logicalWidth * devicePixelRatio * zoom).round();
  if (desktop && width < 1280) width = 1280;
  if (width < 240) return 240;
  if (width > 2560) return 2560;
  return width;
}

Map<String, Object> browserFrameWatchRequest({
  required String rid,
  required String tab,
  required int width,
  required int fps,
  required bool desktop,
}) {
  _checkRef(tab, '브라우저 탭');
  if (width < 240 || width > 2560 || fps < 1 || fps > 4) {
    throw const ProtocolException('브라우저 화면 크기나 갱신 횟수가 올바르지 않습니다.');
  }
  return {
    'type': 'browser.frame.watch',
    'rid': _checkedRid(rid),
    'tab': tab,
    'width': width,
    'fps': fps,
    'desktop': desktop,
  };
}

Map<String, Object> _pointRequest({
  required String type,
  required String rid,
  required String tab,
  required double x,
  required double y,
  required int width,
  required int height,
}) {
  _checkRef(tab, '브라우저 탭');
  if (!x.isFinite ||
      !y.isFinite ||
      x < 0 ||
      y < 0 ||
      x > width ||
      y > height ||
      width < 1 ||
      width > 4096 ||
      height < 1 ||
      height > 4096) {
    throw const ProtocolException('브라우저 좌표가 올바르지 않습니다.');
  }
  return {
    'type': type,
    'rid': _checkedRid(rid),
    'tab': tab,
    'x': x,
    'y': y,
    'width': width,
    'height': height,
  };
}

Map<String, Object> browserPointerRequest({
  required String rid,
  required String tab,
  required double x,
  required double y,
  required int width,
  required int height,
  String action = 'click',
}) {
  if (!const {'click', 'double'}.contains(action)) {
    throw const ProtocolException('브라우저 누르기 동작이 올바르지 않습니다.');
  }
  return {
    ..._pointRequest(
      type: 'browser.pointer',
      rid: rid,
      tab: tab,
      x: x,
      y: y,
      width: width,
      height: height,
    ),
    'action': action,
  };
}

Map<String, Object> browserMouseRequest({
  required String rid,
  required String tab,
  required double x,
  required double y,
  required int width,
  required int height,
  required String action,
  int? dy,
}) {
  if (!const {
    'move',
    'click',
    'double',
    'context',
    'wheel',
    'down',
    'drag',
    'up',
  }.contains(action)) {
    throw const ProtocolException('브라우저 마우스 동작이 올바르지 않습니다.');
  }
  if (action == 'wheel') {
    if (dy == null || dy == 0 || dy < -20000 || dy > 20000) {
      throw const ProtocolException('브라우저 휠 값이 올바르지 않습니다.');
    }
  } else if (dy != null) {
    throw const ProtocolException('휠 동작이 아닌 요청에는 휠 값을 보낼 수 없습니다.');
  }
  return {
    ..._pointRequest(
      type: 'browser.mouse',
      rid: rid,
      tab: tab,
      x: x,
      y: y,
      width: width,
      height: height,
    ),
    'action': action,
    'dy': ?dy,
  };
}

Map<String, Object> browserTypeRequest({
  required String rid,
  required String tab,
  required String text,
}) {
  _checkRef(tab, '브라우저 탭');
  _checkAdvancedText(text, 4000, '브라우저 입력');
  return {
    'type': 'browser.type',
    'rid': _checkedRid(rid),
    'tab': tab,
    'text': text,
  };
}

Map<String, Object> browserKeyRequest({
  required String rid,
  required String tab,
  required String key,
  required KeyModifiers modifiers,
}) {
  _checkRef(tab, '브라우저 탭');
  _checkKey(key);
  return {
    'type': 'browser.key',
    'rid': _checkedRid(rid),
    'tab': tab,
    'key': key,
    'modifiers': modifiers.toJson(),
  };
}

Map<String, Object> browserScrollRequest({
  required String rid,
  required String tab,
  required int dy,
}) {
  _checkRef(tab, '브라우저 탭');
  if (dy == 0 || dy < -20000 || dy > 20000) {
    throw const ProtocolException('브라우저 스크롤 값이 올바르지 않습니다.');
  }
  return {
    'type': 'browser.scroll',
    'rid': _checkedRid(rid),
    'tab': tab,
    'dy': dy,
  };
}

Map<String, Object> browserHistoryRequest({
  required String rid,
  required String tab,
  required String action,
}) {
  _checkRef(tab, '브라우저 탭');
  if (!const {'back', 'forward', 'reload'}.contains(action)) {
    throw const ProtocolException('브라우저 이동 동작이 올바르지 않습니다.');
  }
  return {
    'type': 'browser.history',
    'rid': _checkedRid(rid),
    'tab': tab,
    'action': action,
  };
}

Map<String, Object> browserNavigateRequest({
  required String rid,
  required String tab,
  required String url,
}) {
  _checkRef(tab, '브라우저 탭');
  _checkHttpUrl(url);
  return {
    'type': 'browser.navigate',
    'rid': _checkedRid(rid),
    'tab': tab,
    'url': url,
  };
}

Map<String, Object> browserNewTabRequest({
  required String rid,
  required String space,
  String? url,
  String? title,
  String? profile,
  String? agent,
  String? media,
}) {
  _checkRef(space, '스페이스');
  if (agent != null) _checkRef(agent, '세션');
  if (media != null) _checkRef(media, '파일');
  if (url != null) _checkHttpUrl(url);
  if (title != null) _checkAdvancedText(title, 80, '탭 제목');
  if (profile != null) _checkAdvancedText(profile, 60, '프로필');
  return {
    'type': 'browser.tab.new',
    'rid': _checkedRid(rid),
    'space': space,
    'url': ?url,
    'title': ?title,
    'profile': ?profile,
    'agent': ?agent,
    'media': ?media,
  };
}

Map<String, Object> browserElementRequest({
  required String rid,
  required String tab,
  required double x,
  required double y,
  required int width,
  required int height,
}) => _pointRequest(
  type: 'browser.element',
  rid: rid,
  tab: tab,
  x: x,
  y: y,
  width: width,
  height: height,
);

Map<String, Object> browserElementHoverRequest({
  required String rid,
  required String tab,
  required double x,
  required double y,
  required int width,
  required int height,
}) => _pointRequest(
  type: 'browser.element.hover',
  rid: rid,
  tab: tab,
  x: x,
  y: y,
  width: width,
  height: height,
);

Map<String, Object> browserElementPickRequest({
  required String rid,
  required String tab,
  required String agent,
  required double x,
  required double y,
  required int width,
  required int height,
}) {
  _checkRef(agent, '에이전트');
  return {
    ..._pointRequest(
      type: 'browser.element.pick',
      rid: rid,
      tab: tab,
      x: x,
      y: y,
      width: width,
      height: height,
    ),
    'agent': agent,
  };
}

Map<String, Object> browserFocusRequest({
  required String rid,
  required String tab,
}) {
  _checkRef(tab, '브라우저 탭');
  return {'type': 'browser.focus', 'rid': _checkedRid(rid), 'tab': tab};
}

Map<String, Object> browserDialogRequest({
  required String rid,
  required String tab,
  required String action,
  String? text,
}) {
  _checkRef(tab, '브라우저 탭');
  if (!const {'get', 'accept', 'cancel'}.contains(action) ||
      action != 'accept' && text != null) {
    throw const ProtocolException('브라우저 대화상자 응답이 올바르지 않습니다.');
  }
  if (text != null) {
    _checkAdvancedText(text, 2000, '대화상자 글', allowNewlines: true);
  }
  return {
    'type': 'browser.dialog',
    'rid': _checkedRid(rid),
    'tab': tab,
    'action': action,
    'text': ?text,
  };
}

Map<String, Object> browserElementSendRequest({
  required String rid,
  required String tab,
  required String agent,
  required double x,
  required double y,
  required int width,
  required int height,
  required String text,
}) {
  _checkRef(agent, '에이전트');
  _checkAdvancedText(text, 2000, '요청 글', allowNewlines: true);
  return {
    ..._pointRequest(
      type: 'browser.element.send',
      rid: rid,
      tab: tab,
      x: x,
      y: y,
      width: width,
      height: height,
    ),
    'agent': agent,
    'text': text,
  };
}

Map<String, Object> browserRecordStartRequest({
  required String rid,
  required String tab,
}) {
  _checkRef(tab, '브라우저 탭');
  return {'type': 'browser.record.start', 'rid': _checkedRid(rid), 'tab': tab};
}

Map<String, Object> browserRecordPauseRequest({
  required String rid,
  required bool paused,
}) => {
  'type': 'browser.record.pause',
  'rid': _checkedRid(rid),
  'paused': paused,
};

Map<String, Object> browserRecordFinishRequest({
  required String rid,
  required String agent,
  String? note,
}) {
  _checkRef(agent, '에이전트');
  if (note != null) {
    _checkAdvancedText(note, 2000, '조작 기록 설명', allowNewlines: true);
  }
  return {
    'type': 'browser.record.finish',
    'rid': _checkedRid(rid),
    'agent': agent,
    'note': ?note,
  };
}

Map<String, Object> browserSketchSendRequest({
  required String rid,
  required String agent,
  required String tab,
  required String image,
  required String text,
}) {
  _checkRef(agent, '에이전트');
  _checkRef(tab, '브라우저 탭');
  _checkAdvancedText(text, 2000, '스케치 설명', allowNewlines: true);
  if (image.length > 48 * 1024 ||
      !RegExp(r'^data:image/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$')
          .hasMatch(image)) {
    throw const ProtocolException('스케치 이미지가 올바르지 않습니다.');
  }
  return {
    'type': 'browser.sketch.send',
    'rid': _checkedRid(rid),
    'agent': agent,
    'tab': tab,
    'image': image,
    'text': text,
  };
}

Map<String, Object> browserDraftRemoveRequest({
  required String rid,
  required String ref,
}) {
  _checkRef(ref, '붙여넣기');
  return {'type': 'browser.draft.remove', 'rid': _checkedRid(rid), 'ref': ref};
}

Map<String, Object> browserProfilesRequest(String rid) => {
  'type': 'browser.profiles',
  'rid': _checkedRid(rid),
};

Map<String, Object> browserProfileSetRequest({
  required String rid,
  required String tab,
  required String profile,
}) {
  _checkRef(tab, '브라우저 탭');
  _checkAdvancedText(profile, 60, '프로필');
  return {
    'type': 'browser.profile.set',
    'rid': _checkedRid(rid),
    'tab': tab,
    'profile': profile,
  };
}

Map<String, Object> browserDesktopRequest({
  required String rid,
  required String tab,
  required bool enabled,
}) {
  _checkRef(tab, '브라우저 탭');
  return {
    'type': 'browser.desktop',
    'rid': _checkedRid(rid),
    'tab': tab,
    'enabled': enabled,
  };
}

Map<String, Object> _browserTabOnly(String type, String rid, String tab) {
  _checkRef(tab, '브라우저 탭');
  return {'type': type, 'rid': _checkedRid(rid), 'tab': tab};
}

Map<String, Object> browserTranslateRequest({
  required String rid,
  required String tab,
}) => _browserTabOnly('browser.translate', rid, tab);
Map<String, Object> browserDirectRequest({
  required String rid,
  required String tab,
}) => _browserTabOnly('browser.direct', rid, tab);

Map<String, Object> browserBookmarksRequest({
  required String rid,
  required String space,
}) {
  _checkRef(space, '스페이스');
  return {'type': 'browser.bookmarks', 'rid': _checkedRid(rid), 'space': space};
}

Map<String, Object> browserBookmarkSetRequest({
  required String rid,
  required String tab,
  required bool bookmarked,
}) {
  _checkRef(tab, '브라우저 탭');
  return {
    'type': 'browser.bookmark.set',
    'rid': _checkedRid(rid),
    'tab': tab,
    'bookmarked': bookmarked,
  };
}

Map<String, Object> gitChangesRequest({
  required String rid,
  required String agent,
}) {
  _checkRef(agent, '에이전트');
  return {'type': 'git.changes', 'rid': _checkedRid(rid), 'agent': agent};
}

Map<String, Object> gitDiffRequest({
  required String rid,
  required String agent,
  required String file,
  required String view,
  String? base,
}) {
  _checkRef(agent, '에이전트');
  _checkRef(file, '파일');
  if (!const {'working', 'staged', 'branch'}.contains(view)) {
    throw const ProtocolException('diff 보기가 올바르지 않습니다.');
  }
  if (base != null) _checkAdvancedText(base, 200, '기준 브랜치');
  return {
    'type': 'git.diff',
    'rid': _checkedRid(rid),
    'agent': agent,
    'file': file,
    'view': view,
    'base': ?base,
  };
}

Map<String, Object> gitDiffDraftRequest({
  required String rid,
  required String agent,
  required String file,
  required String side,
  required int line,
  required String text,
}) {
  _checkRef(agent, '에이전트');
  _checkRef(file, '파일');
  if (!const {'old', 'new'}.contains(side) || line < 1 || line > 10000000) {
    throw const ProtocolException('diff 줄이 올바르지 않습니다.');
  }
  _checkAdvancedText(text, 4000, '줄 의견', allowNewlines: true);
  return {
    'type': 'git.diff.draft',
    'rid': _checkedRid(rid),
    'agent': agent,
    'file': file,
    'side': side,
    'line': line,
    'text': text,
  };
}

Map<String, Object> githubPrRequest({
  required String rid,
  required String agent,
}) {
  _checkRef(agent, '에이전트');
  return {'type': 'github.pr', 'rid': _checkedRid(rid), 'agent': agent};
}

Map<String, Object> githubCheckLogRequest({
  required String rid,
  required String agent,
  required String run,
}) {
  _checkRef(agent, '에이전트');
  if (!RegExp(r'^\d{1,18}$').hasMatch(run)) {
    throw const ProtocolException('검사 번호가 올바르지 않습니다.');
  }
  return {
    'type': 'github.check.log',
    'rid': _checkedRid(rid),
    'agent': agent,
    'run': run,
  };
}

Map<String, Object> githubCheckDraftRequest({
  required String rid,
  required String agent,
  required String run,
  String? text,
}) {
  _checkRef(agent, '에이전트');
  if (!RegExp(r'^\d{1,18}$').hasMatch(run)) {
    throw const ProtocolException('검사 번호가 올바르지 않습니다.');
  }
  if (text != null) {
    _checkAdvancedText(text, 2000, '검사 요청 글', allowNewlines: true);
  }
  return {
    'type': 'github.check.draft',
    'rid': _checkedRid(rid),
    'agent': agent,
    'run': run,
    'text': ?text,
  };
}

ServerMessage? _parseAdvancedServerMessage(Map<String, dynamic> value) {
  switch (value['type']) {
    case 'remote.action.result':
      final actionValue = Map<String, dynamic>.from(value)..remove('tab');
      if (_hasExactKeys(actionValue, {'type', 'rid', 'result'}) &&
          _validRid(value['rid']) &&
          const {'done', 'unchanged', 'sent'}.contains(value['result']) &&
          (!value.containsKey('tab') || _validRef(value['tab']))) {
        return RemoteActionResult(
          rid: value['rid'] as String,
          result: value['result'] as String,
          tab: value['tab'] as String?,
        );
      }
    case 'terminal.watch.result':
      if (_hasKeys(value, {
            'type',
            'rid',
            'agent',
            'revision',
            'text',
            'truncated',
          }) &&
          _validRid(value['rid'])) {
        final frame = _parseTerminalFrame(value, hasRid: true);
        if (frame != null) {
          return TerminalWatchResult(
            rid: value['rid'] as String,
            agent: frame.agent,
            revision: frame.revision,
            text: frame.text,
            truncated: frame.truncated,
            hash: frame.hash,
            columns: frame.columns,
            rows: frame.rows,
            mouseMode: frame.mouseMode,
            error: frame.error,
          );
        }
      }
    case 'terminal.frame':
      return _parseTerminalFrame(value, hasRid: false);
    case 'terminal.scrollback.result':
      if (_hasExactKeys(value, {
            'type',
            'rid',
            'agent',
            'text',
            'columns',
            'lineCount',
          }) &&
          _validRid(value['rid']) &&
          _validRef(value['agent']) &&
          value['text'] is String &&
          _validPossiblyEmptyString(value['text'] as String, maximum: 49152) &&
          value['columns'] is int &&
          (value['columns'] as int) >= 1 &&
          (value['columns'] as int) <= 4096 &&
          value['lineCount'] is int &&
          (value['lineCount'] as int) >= 1 &&
          (value['lineCount'] as int) <= 49153) {
        return TerminalScrollback(
          rid: value['rid'] as String,
          agent: value['agent'] as String,
          text: value['text'] as String,
          columns: value['columns'] as int,
          lineCount: value['lineCount'] as int,
        );
      }
    case 'terminal.keys':
      return _parseTerminalKeys(value);
    case 'browser.tabs.result':
      return _parseBrowserTabs(value);
    case 'browser.frame.watch.result':
      if (_hasExactKeys(value, {'type', 'rid', 'tab', 'watching'}) &&
          _validRid(value['rid']) &&
          _validRef(value['tab']) &&
          value['watching'] == true) {
        return BrowserFrameWatchResult(
          rid: value['rid'] as String,
          tab: value['tab'] as String,
        );
      }
    case 'browser.frame':
      return _parseBrowserFrame(value);
    case 'browser.element.result':
      return _parseBrowserElementResult(value);
    case 'browser.element.hover.result':
      return _parseBrowserElementHoverResult(value);
    case 'browser.focus.result':
      return _parseBrowserFocusResult(value);
    case 'browser.dialog.result':
      return _parseBrowserDialogResult(value);
    case 'browser.record.result':
      if (_hasExactKeys(value, {
            'type',
            'rid',
            'state',
            'steps',
            'elapsedMs',
          }) &&
          _validRid(value['rid']) &&
          const {'recording', 'paused', 'finished'}.contains(value['state']) &&
          value['steps'] is List &&
          value['elapsedMs'] is int &&
          (value['elapsedMs'] as int) >= 0 &&
          (value['steps'] as List).every(
            (step) => step is String && _validString(step, maximum: 500),
          )) {
        return BrowserRecordResult(
          rid: value['rid'] as String,
          state: value['state'] as String,
          steps: List<String>.unmodifiable((value['steps'] as List).cast()),
          elapsedMs: value['elapsedMs'] as int,
        );
      }
    case 'browser.draft.result':
      if (_hasExactKeys(value, {
            'type',
            'rid',
            'ref',
            'kind',
            'summary',
            'content',
          }) &&
          _validRid(value['rid']) &&
          _validRef(value['ref']) &&
          const {'element', 'record', 'sketch'}.contains(value['kind']) &&
          value['summary'] is String &&
          _validString(value['summary'] as String, maximum: 80) &&
          value['content'] is String &&
          _validString(value['content'] as String, maximum: 128 * 1024)) {
        return BrowserDraftResult(
          rid: value['rid'] as String,
          ref: value['ref'] as String,
          kind: value['kind'] as String,
          summary: value['summary'] as String,
          content: value['content'] as String,
        );
      }
    case 'browser.profiles.result':
      if (_hasExactKeys(value, {'type', 'rid', 'profiles'}) &&
          _validRid(value['rid']) &&
          value['profiles'] is List &&
          (value['profiles'] as List).every(
            (name) => name is String && _validString(name, maximum: 60),
          )) {
        return BrowserProfilesResult(
          rid: value['rid'] as String,
          profiles: List<String>.unmodifiable(
            (value['profiles'] as List).cast(),
          ),
        );
      }
    case 'browser.bookmarks.result':
      return _parseBrowserBookmarks(value);
    case 'git.changes.result':
      return _parseGitChanges(value);
    case 'git.diff.result':
      if (_hasExactKeys(value, {'type', 'rid', 'file', 'patch', 'truncated'}) &&
          _validRid(value['rid']) &&
          _validRef(value['file']) &&
          value['patch'] is String &&
          _validPossiblyEmptyString(value['patch'] as String, maximum: 48000) &&
          value['truncated'] is bool) {
        return GitDiffResult(
          rid: value['rid'] as String,
          file: value['file'] as String,
          patch: value['patch'] as String,
          truncated: value['truncated'] as bool,
        );
      }
    case 'github.pr.result':
      return _parseGitHubPr(value);
    case 'github.check.log.result':
      if (_hasExactKeys(value, {'type', 'rid', 'run', 'log', 'truncated'}) &&
          _validRid(value['rid']) &&
          value['run'] is String &&
          RegExp(r'^\d{1,18}$').hasMatch(value['run'] as String) &&
          value['log'] is String &&
          _validPossiblyEmptyString(value['log'] as String, maximum: 40000) &&
          value['truncated'] is bool) {
        return GitHubCheckLogResult(
          rid: value['rid'] as String,
          run: value['run'] as String,
          log: value['log'] as String,
          truncated: value['truncated'] as bool,
        );
      }
  }
  return null;
}

TerminalFrame? _parseTerminalFrame(
  Map<String, dynamic> value, {
  required bool hasRid,
}) {
  final required = hasRid
      ? {'type', 'rid', 'agent', 'revision', 'text', 'truncated'}
      : {'type', 'agent', 'revision', 'text', 'truncated'};
  const extras = {'hash', 'columns', 'rows', 'mouseMode', 'error'};
  if (!_hasKeys(value, required) ||
      value.keys.any(
        (key) => !required.contains(key) && !extras.contains(key),
      ) ||
      (value.containsKey('hash') &&
          (value['hash'] is! String ||
              !RegExp(r'^[0-9a-f]{64}$').hasMatch(value['hash'] as String))) ||
      (value.containsKey('columns') &&
          (value['columns'] is! int ||
              (value['columns'] as int) < 1 ||
              (value['columns'] as int) > 4096)) ||
      (value.containsKey('rows') &&
          (value['rows'] is! int ||
              (value['rows'] as int) < 1 ||
              (value['rows'] as int) > 4096)) ||
      (value.containsKey('mouseMode') && value['mouseMode'] is! bool) ||
      (value.containsKey('error') &&
          !{
            'terminal-frame-too-large',
            'terminal-layout-unavailable',
            'terminal-read-unavailable',
          }.contains(value['error'])) ||
      !_validRef(value['agent']) ||
      value['revision'] is! int ||
      (value['revision'] as int) < 0 ||
      value['text'] is! String ||
      !_validPossiblyEmptyString(value['text'] as String, maximum: 49152) ||
      value['truncated'] is! bool) {
    return null;
  }
  return TerminalFrame(
    agent: value['agent'] as String,
    revision: value['revision'] as int,
    text: value['text'] as String,
    truncated: value['truncated'] as bool,
    hash: value['hash'] is String ? value['hash'] as String : null,
    columns: value['columns'] is int ? value['columns'] as int : null,
    rows: value['rows'] is int ? value['rows'] as int : null,
    mouseMode: value['mouseMode'] == true,
    error: value['error'] is String ? value['error'] as String : null,
  );
}

TerminalKeys? _parseTerminalKeys(Map<String, dynamic> value) {
  if (!_hasExactKeys(value, {
        'type',
        'rid',
        'keys',
        'defaults',
        'macShortcuts',
      }) ||
      !_validRid(value['rid']) ||
      value['keys'] is! List ||
      value['defaults'] is! List ||
      value['macShortcuts'] is! List) {
    return null;
  }
  final keys = _parseList(value['keys'], _parseTerminalKey);
  final defaults = _parseList(value['defaults'], _parseTerminalKey);
  final shortcuts = _parseList(value['macShortcuts'], _parseMacShortcut);
  if (keys == null ||
      defaults == null ||
      shortcuts == null ||
      keys.length > 24 ||
      defaults.length > 24) {
    return null;
  }
  return TerminalKeys(
    rid: value['rid'] as String,
    keys: keys,
    defaults: defaults,
    macShortcuts: shortcuts,
  );
}

KeyModifiers? _parseModifiers(Object? value) {
  if (!_hasExactKeys(value, {'ctrl', 'alt', 'shift', 'cmd'})) return null;
  final map = value! as Map<String, dynamic>;
  if ([
    map['ctrl'],
    map['alt'],
    map['shift'],
    map['cmd'],
  ].any((part) => part is! bool)) {
    return null;
  }
  return KeyModifiers(
    ctrl: map['ctrl'] as bool,
    alt: map['alt'] as bool,
    shift: map['shift'] as bool,
    cmd: map['cmd'] as bool,
  );
}

TerminalKeyButton? _parseTerminalKey(Object? value) {
  if (!_hasExactKeys(value, {'id', 'label', 'key', 'modifiers'})) return null;
  final map = value! as Map<String, dynamic>;
  final modifiers = _parseModifiers(map['modifiers']);
  if (map['id'] is! String ||
      !RegExp(r'^[A-Za-z0-9_-]{1,32}$').hasMatch(map['id'] as String) ||
      map['label'] is! String ||
      !_validString(map['label'] as String, maximum: 24) ||
      map['key'] is! String ||
      !_validString(map['key'] as String, maximum: 24) ||
      modifiers == null) {
    return null;
  }
  return TerminalKeyButton(
    id: map['id'] as String,
    label: map['label'] as String,
    key: map['key'] as String,
    modifiers: modifiers,
  );
}

MacShortcut? _parseMacShortcut(Object? value) {
  if (!_hasExactKeys(value, {'id', 'label', 'keys'})) return null;
  final map = value! as Map<String, dynamic>;
  if ([
    map['id'],
    map['label'],
    map['keys'],
  ].any((part) => part is! String || !_validString(part, maximum: 100))) {
    return null;
  }
  return MacShortcut(
    id: map['id'] as String,
    label: map['label'] as String,
    keys: map['keys'] as String,
  );
}

BrowserTabsResult? _parseBrowserTabs(Map<String, dynamic> value) {
  if (!_hasExactKeys(Map<String, dynamic>.from(value)..remove('groups'), {
        'type',
        'rid',
        'spaces',
        'tabs',
      }) ||
      (value.containsKey('groups') && value['groups'] is! List) ||
      !_validRid(value['rid']) ||
      value['spaces'] is! List ||
      value['tabs'] is! List) {
    return null;
  }
  final spaces = _parseList(value['spaces'], _parseBrowserSpace);
  final groups = value['groups'] == null
      ? <BrowserTabGroupInfo>[]
      : _parseList(value['groups'], _parseBrowserGroup);
  final tabs = _parseList(value['tabs'], _parseBrowserTab);
  return spaces == null || groups == null || tabs == null
      ? null
      : BrowserTabsResult(
          rid: value['rid'] as String,
          spaces: spaces,
          groups: groups,
          tabs: tabs,
        );
}

BrowserTabGroupInfo? _parseBrowserGroup(Object? value) {
  if (value is! Map<String, dynamic>) return null;
  final candidate = Map<String, dynamic>.from(value)..remove('color');
  if (!_hasExactKeys(candidate, {'ref', 'space', 'name', 'collapsed'})) {
    return null;
  }
  final map = value;
  return _validRef(map['ref']) &&
          _validRef(map['space']) &&
          map['name'] is String &&
          _validString(map['name'] as String, maximum: 80) &&
          map['collapsed'] is bool &&
          (!map.containsKey('color') ||
              map['color'] is String &&
                  _validString(map['color'] as String, maximum: 32))
      ? BrowserTabGroupInfo(
          ref: map['ref'] as String,
          space: map['space'] as String,
          name: map['name'] as String,
          collapsed: map['collapsed'] as bool,
          color: map['color'] as String?,
        )
      : null;
}

BrowserSpace? _parseBrowserSpace(Object? value) {
  if (!_hasExactKeys(value, {'ref', 'name'})) return null;
  final map = value! as Map<String, dynamic>;
  return _validRef(map['ref']) &&
          map['name'] is String &&
          _validString(map['name'] as String, maximum: 80)
      ? BrowserSpace(ref: map['ref'] as String, name: map['name'] as String)
      : null;
}

BrowserTab? _parseBrowserTab(Object? value) {
  if (!_hasExactKeys(
    value is Map<String, dynamic>
        ? (Map<String, dynamic>.from(value)
            ..remove('sessions')
            ..remove('group'))
        : value,
    {
      'ref',
      'space',
      'title',
      'url',
      'profile',
      'aiControlled',
      'controlling',
      'active',
      'sleeping',
    },
  )) {
    return null;
  }
  final map = value! as Map<String, dynamic>;
  if (!_validRef(map['ref']) ||
      !_validRef(map['space']) ||
      map['title'] is! String ||
      !_validString(map['title'] as String, maximum: 200) ||
      map['url'] is! String ||
      !_validPossiblyEmptyString(map['url'] as String, maximum: 2048) ||
      map['profile'] is! String ||
      !_validString(map['profile'] as String, maximum: 60) ||
      map['aiControlled'] is! bool ||
      map['controlling'] is! List ||
      !(map['controlling'] as List).every(
        (name) => name is String && _validString(name, maximum: 34),
      ) ||
      (map.containsKey('sessions') &&
          (map['sessions'] is! List ||
              !(map['sessions'] as List).every(_validRef))) ||
      (map.containsKey('group') &&
          map['group'] != null &&
          !_validRef(map['group'])) ||
      map['active'] is! bool ||
      map['sleeping'] is! bool) {
    return null;
  }
  return BrowserTab(
    ref: map['ref'] as String,
    space: map['space'] as String,
    title: map['title'] as String,
    url: map['url'] as String,
    profile: map['profile'] as String,
    aiControlled: map['aiControlled'] as bool,
    controlling: List<String>.unmodifiable((map['controlling'] as List).cast()),
    sessions: List<String>.unmodifiable(
      ((map['sessions'] as List?) ?? []).cast(),
    ),
    group: map['group'] as String?,
    active: map['active'] as bool,
    sleeping: map['sleeping'] as bool,
  );
}

BrowserFrame? _parseBrowserFrame(Map<String, dynamic> value) {
  if (!_hasExactKeys(value, {
        'type',
        'tab',
        'seq',
        'width',
        'height',
        'jpeg',
      }) ||
      !_validRef(value['tab']) ||
      value['seq'] is! int ||
      (value['seq'] as int) < 1 ||
      value['width'] is! int ||
      (value['width'] as int) < 1 ||
      value['height'] is! int ||
      (value['height'] as int) < 1 ||
      value['jpeg'] is! String ||
      !_canonicalBase64(value['jpeg'] as String, maximumBytes: 384 * 1024)) {
    return null;
  }
  return BrowserFrame(
    tab: value['tab'] as String,
    seq: value['seq'] as int,
    width: value['width'] as int,
    height: value['height'] as int,
    jpeg: Uint8List.fromList(base64Decode(value['jpeg'] as String)),
  );
}

BrowserElementResult? _parseBrowserElementResult(Map<String, dynamic> value) {
  if (!_hasExactKeys(value, {'type', 'rid', 'element'}) ||
      !_validRid(value['rid'])) {
    return null;
  }
  if (value['element'] == null) {
    return BrowserElementResult(rid: value['rid'] as String, element: null);
  }
  final parsed = _parseBrowserElement(value['element']);
  if (parsed == null) return null;
  return BrowserElementResult(rid: value['rid'] as String, element: parsed);
}

BrowserElement? _parseBrowserElement(Object? element) {
  if (!_hasExactKeys(element, {'selector', 'text', 'rect'})) return null;
  final map = element! as Map<String, dynamic>;
  if (map['selector'] is! String ||
      !_validString(map['selector'] as String, maximum: 2000) ||
      map['text'] is! String ||
      !_validPossiblyEmptyString(map['text'] as String, maximum: 300) ||
      !_hasExactKeys(map['rect'], {'x', 'y', 'width', 'height'})) {
    return null;
  }
  final rect = map['rect']! as Map<String, dynamic>;
  if (![
    rect['x'],
    rect['y'],
    rect['width'],
    rect['height'],
  ].every((part) => part is num && part.isFinite)) {
    return null;
  }
  return BrowserElement(
    selector: map['selector'] as String,
    text: map['text'] as String,
    rect: BrowserElementRect(
      x: (rect['x'] as num).toDouble(),
      y: (rect['y'] as num).toDouble(),
      width: (rect['width'] as num).toDouble(),
      height: (rect['height'] as num).toDouble(),
    ),
  );
}

BrowserElementHoverResult? _parseBrowserElementHoverResult(
  Map<String, dynamic> value,
) {
  if (!_hasExactKeys(value, {'type', 'rid', 'viewport', 'element'}) ||
      !_validRid(value['rid']) ||
      !_hasExactKeys(value['viewport'], {'width', 'height'})) {
    return null;
  }
  final viewport = value['viewport']! as Map<String, dynamic>;
  if (viewport['width'] is! num ||
      !(viewport['width'] as num).isFinite ||
      (viewport['width'] as num) <= 0 ||
      viewport['height'] is! num ||
      !(viewport['height'] as num).isFinite ||
      (viewport['height'] as num) <= 0) {
    return null;
  }
  final element = value['element'] == null
      ? null
      : _parseBrowserElement(value['element']);
  if (value['element'] != null && element == null) return null;
  return BrowserElementHoverResult(
    rid: value['rid'] as String,
    viewport: BrowserViewport(
      width: (viewport['width'] as num).toDouble(),
      height: (viewport['height'] as num).toDouble(),
    ),
    element: element,
  );
}

BrowserFocusResult? _parseBrowserFocusResult(Map<String, dynamic> value) {
  if (!_hasExactKeys(value, {
        'type',
        'rid',
        'editable',
        'kind',
        'multiline',
        'selectedText',
      }) ||
      !_validRid(value['rid']) ||
      value['editable'] is! bool ||
      !const {'none', 'text', 'multiline', 'select'}.contains(value['kind']) ||
      value['multiline'] is! bool ||
      value['selectedText'] is! String ||
      !_validPossiblyEmptyString(
        value['selectedText'] as String,
        maximum: 4000,
      )) {
    return null;
  }
  return BrowserFocusResult(
    rid: value['rid'] as String,
    editable: value['editable'] as bool,
    kind: value['kind'] as String,
    multiline: value['multiline'] as bool,
    selectedText: value['selectedText'] as String,
  );
}

BrowserDialogResult? _parseBrowserDialogResult(Map<String, dynamic> value) {
  if (!_hasExactKeys(value, {'type', 'rid', 'dialog'}) ||
      !_validRid(value['rid'])) {
    return null;
  }
  if (value['dialog'] == null) {
    return BrowserDialogResult(rid: value['rid'] as String, dialog: null);
  }
  if (!_hasExactKeys(value['dialog'], {'kind', 'message'})) return null;
  final dialog = value['dialog']! as Map<String, dynamic>;
  if (!const {
        'alert',
        'confirm',
        'prompt',
        'beforeunload',
      }.contains(dialog['kind']) ||
      dialog['message'] is! String ||
      !_validPossiblyEmptyString(dialog['message'] as String, maximum: 300)) {
    return null;
  }
  return BrowserDialogResult(
    rid: value['rid'] as String,
    dialog: BrowserDialog(
      kind: dialog['kind'] as String,
      message: dialog['message'] as String,
    ),
  );
}

BrowserBookmarksResult? _parseBrowserBookmarks(Map<String, dynamic> value) {
  if (!_hasExactKeys(value, {'type', 'rid', 'bookmarks'}) ||
      !_validRid(value['rid']) ||
      value['bookmarks'] is! List ||
      (value['bookmarks'] as List).length > 200) {
    return null;
  }
  final bookmarks = _parseList(value['bookmarks'], (item) {
    if (!_hasExactKeys(item, {'title', 'url', 'folder'})) return null;
    final map = item! as Map<String, dynamic>;
    if (map['title'] is! String ||
        !_validString(map['title'] as String, maximum: 60) ||
        map['url'] is! String ||
        !_validString(map['url'] as String, maximum: 2048) ||
        (map['folder'] != null &&
            (map['folder'] is! String ||
                !_validString(map['folder'] as String, maximum: 60)))) {
      return null;
    }
    return BrowserBookmark(
      title: map['title'] as String,
      url: map['url'] as String,
      folder: map['folder'] as String?,
    );
  });
  return bookmarks == null
      ? null
      : BrowserBookmarksResult(
          rid: value['rid'] as String,
          bookmarks: bookmarks,
        );
}

GitChangesResult? _parseGitChanges(Map<String, dynamic> value) {
  if (!_hasExactKeys(value, {
        'type',
        'rid',
        'branch',
        'ahead',
        'behind',
        'base',
        'commitCount',
        'additions',
        'deletions',
        'files',
        'bases',
      }) ||
      !_validRid(value['rid']) ||
      value['branch'] is! String ||
      !_validPossiblyEmptyString(value['branch'] as String, maximum: 300) ||
      value['ahead'] is! int ||
      value['behind'] is! int ||
      value['base'] is! String ||
      !_validPossiblyEmptyString(value['base'] as String, maximum: 300) ||
      !_validNullableCount(value['commitCount']) ||
      !_validNullableCount(value['additions']) ||
      !_validNullableCount(value['deletions']) ||
      value['files'] is! List ||
      (value['files'] as List).length > 500 ||
      value['bases'] is! List) {
    return null;
  }
  final files = _parseList(value['files'], (item) {
    if (!_hasExactKeys(item, {
      'ref',
      'path',
      'code',
      'staged',
      'untracked',
      'additions',
      'deletions',
    })) {
      return null;
    }
    final map = item! as Map<String, dynamic>;
    if (!_validRef(map['ref']) ||
        map['path'] is! String ||
        !_validString(map['path'] as String, maximum: 1000) ||
        map['code'] is! String ||
        !_validString(map['code'] as String, maximum: 20) ||
        map['staged'] is! bool ||
        map['untracked'] is! bool ||
        !_validNullableCount(map['additions']) ||
        !_validNullableCount(map['deletions'])) {
      return null;
    }
    return GitFileChange(
      ref: map['ref'] as String,
      path: map['path'] as String,
      code: map['code'] as String,
      staged: map['staged'] as bool,
      untracked: map['untracked'] as bool,
      additions: map['additions'] as int?,
      deletions: map['deletions'] as int?,
    );
  });
  if (files == null ||
      !(value['bases'] as List).every(
        (base) => base is String && _validString(base, maximum: 300),
      )) {
    return null;
  }
  return GitChangesResult(
    rid: value['rid'] as String,
    branch: value['branch'] as String,
    ahead: value['ahead'] as int,
    behind: value['behind'] as int,
    base: value['base'] as String,
    commitCount: value['commitCount'] as int?,
    additions: value['additions'] as int?,
    deletions: value['deletions'] as int?,
    files: files,
    bases: List<String>.unmodifiable((value['bases'] as List).cast()),
  );
}

bool _validNullableCount(Object? value) =>
    value == null || (value is int && value >= 0);

GitHubPrResult? _parseGitHubPr(Map<String, dynamic> value) {
  if (!_hasExactKeys(value, {'type', 'rid', 'pr'}) ||
      !_validRid(value['rid']) ||
      value['pr'] is! Map<String, dynamic>) {
    return null;
  }
  final pr = value['pr'] as Map<String, dynamic>;
  const keys = {
    'number',
    'title',
    'url',
    'state',
    'isDraft',
    'head',
    'base',
    'author',
    'body',
    'comments',
    'reviews',
    'reviewComments',
    'files',
    'checks',
    'reviewCommentsLimited',
    'reviewCommentsError',
  };
  if (!_hasExactKeys(pr, keys) ||
      pr['number'] is! int ||
      (pr['number'] as int) < 1 ||
      !_validSafeInteger(pr['number']) ||
      pr['title'] is! String ||
      !_validPossiblyEmptyString(pr['title'] as String, maximum: 500) ||
      pr['url'] is! String ||
      !_validPossiblyEmptyString(pr['url'] as String, maximum: 1000) ||
      pr['state'] is! String ||
      !_validPossiblyEmptyString(pr['state'] as String, maximum: 40) ||
      pr['isDraft'] is! bool ||
      pr['head'] is! String ||
      !_validPossiblyEmptyString(pr['head'] as String, maximum: 300) ||
      pr['base'] is! String ||
      !_validPossiblyEmptyString(pr['base'] as String, maximum: 300) ||
      pr['author'] is! String ||
      !_validPossiblyEmptyString(pr['author'] as String, maximum: 120) ||
      pr['body'] is! String ||
      !_validPossiblyEmptyString(pr['body'] as String, maximum: 20000) ||
      !_validPrList(pr['comments'], 100, _validPrComment) ||
      !_validPrList(pr['reviews'], 100, _validPrReview) ||
      pr['reviewComments'] is! List ||
      (pr['reviewComments'] as List).length > 100 ||
      !_validPrList(pr['files'], 500, _validPrFile) ||
      pr['checks'] is! List ||
      (pr['checks'] as List).length > 150 ||
      pr['reviewCommentsLimited'] is! bool ||
      pr['reviewCommentsError'] is! String ||
      !_validPossiblyEmptyString(
        pr['reviewCommentsError'] as String,
        maximum: 300,
      )) {
    return null;
  }
  final comments = _parseList(pr['reviewComments'], (item) {
    if (!_hasExactKeys(item, {
      'author',
      'body',
      'createdAt',
      'path',
      'line',
      'url',
    })) {
      return null;
    }
    final map = item! as Map<String, dynamic>;
    if (map['author'] is! String ||
        !_validPossiblyEmptyString(map['author'] as String, maximum: 120) ||
        map['body'] is! String ||
        !_validPossiblyEmptyString(map['body'] as String, maximum: 12000) ||
        map['createdAt'] is! String ||
        !_validPossiblyEmptyString(map['createdAt'] as String, maximum: 80) ||
        map['path'] is! String ||
        !_validPossiblyEmptyString(map['path'] as String, maximum: 1000) ||
        (map['line'] != null && !_validSafeInteger(map['line'])) ||
        map['url'] is! String ||
        !_validPossiblyEmptyString(map['url'] as String, maximum: 1000)) {
      return null;
    }
    return GitHubReviewComment(
      author: map['author'] as String,
      body: map['body'] as String,
      path: map['path'] as String,
      line: map['line'] as int?,
    );
  });
  final checks = _parseList(pr['checks'], (item) {
    if (!_hasExactKeys(item, {
      'name',
      'conclusion',
      'status',
      'detailsUrl',
      'runId',
    })) {
      return null;
    }
    final map = item! as Map<String, dynamic>;
    if (map['name'] is! String ||
        !_validString(map['name'] as String, maximum: 200) ||
        map['conclusion'] is! String ||
        !_validPossiblyEmptyString(map['conclusion'] as String, maximum: 40) ||
        map['status'] is! String ||
        !_validPossiblyEmptyString(map['status'] as String, maximum: 40) ||
        map['detailsUrl'] is! String ||
        !_validPossiblyEmptyString(
          map['detailsUrl'] as String,
          maximum: 1000,
        ) ||
        (map['runId'] != null &&
            (map['runId'] is! String ||
                !RegExp(r'^\d{1,18}$').hasMatch(map['runId'] as String)))) {
      return null;
    }
    return GitHubCheck(
      name: map['name'] as String,
      conclusion: map['conclusion'] as String,
      status: map['status'] as String,
      detailsUrl: map['detailsUrl'] as String,
      runId: map['runId'] as String?,
    );
  });
  if (comments == null || checks == null) return null;
  return GitHubPrResult(
    rid: value['rid'] as String,
    pr: GitHubPullRequest(
      number: pr['number'] as int,
      title: pr['title'] as String,
      state: pr['state'] as String,
      isDraft: pr['isDraft'] as bool,
      head: pr['head'] as String,
      base: pr['base'] as String,
      author: pr['author'] as String,
      reviewComments: comments,
      checks: checks,
    ),
  );
}

bool _validSafeInteger(Object? value) =>
    value is int && value >= -9007199254740991 && value <= 9007199254740991;

bool _validPrList(
  Object? value,
  int maximum,
  bool Function(Object?) validate,
) => value is List && value.length <= maximum && value.every(validate);

bool _validPrComment(Object? value) {
  if (!_hasExactKeys(value, {'author', 'body', 'createdAt', 'url'})) {
    return false;
  }
  final map = value! as Map<String, dynamic>;
  return map['author'] is String &&
      _validPossiblyEmptyString(map['author'] as String, maximum: 120) &&
      map['body'] is String &&
      _validPossiblyEmptyString(map['body'] as String, maximum: 12000) &&
      map['createdAt'] is String &&
      _validPossiblyEmptyString(map['createdAt'] as String, maximum: 80) &&
      map['url'] is String &&
      _validPossiblyEmptyString(map['url'] as String, maximum: 1000);
}

bool _validPrReview(Object? value) {
  if (!_hasExactKeys(value, {
    'author',
    'body',
    'state',
    'submittedAt',
    'url',
  })) {
    return false;
  }
  final map = value! as Map<String, dynamic>;
  return map['author'] is String &&
      _validPossiblyEmptyString(map['author'] as String, maximum: 120) &&
      map['body'] is String &&
      _validPossiblyEmptyString(map['body'] as String, maximum: 12000) &&
      map['state'] is String &&
      _validPossiblyEmptyString(map['state'] as String, maximum: 40) &&
      map['submittedAt'] is String &&
      _validPossiblyEmptyString(map['submittedAt'] as String, maximum: 80) &&
      map['url'] is String &&
      _validPossiblyEmptyString(map['url'] as String, maximum: 1000);
}

bool _validPrFile(Object? value) {
  if (!_hasExactKeys(value, {'path', 'additions', 'deletions'})) return false;
  final map = value! as Map<String, dynamic>;
  return map['path'] is String &&
      _validString(map['path'] as String, maximum: 1000) &&
      _validSafeInteger(map['additions']) &&
      _validSafeInteger(map['deletions']);
}

void _checkAdvancedText(
  String value,
  int maximum,
  String name, {
  bool allowNewlines = false,
  bool allowTab = false,
}) {
  final invalid = value.runes.any(
    (rune) =>
        (rune <= 0x1f &&
            !(allowNewlines && (rune == 0x0a || rune == 0x0d)) &&
            !(allowTab && rune == 0x09)) ||
        (rune >= 0x7f && rune <= 0x9f),
  );
  if (!_validString(value, maximum: maximum) || invalid) {
    throw ProtocolException('$name 형식이 올바르지 않습니다.');
  }
}

void _checkKey(String key) {
  _checkAdvancedText(key, 24, '키');
  if (key.contains('\r') || key.contains('\n')) {
    throw const ProtocolException('키에 줄바꿈을 넣을 수 없습니다.');
  }
}

void _checkHttpUrl(String value) {
  final uri = Uri.tryParse(value);
  if (value.length > 2048 ||
      value.runes.any((rune) => rune <= 0x20 || rune == 0x7f) ||
      uri == null ||
      !uri.hasAuthority ||
      !const {'http', 'https'}.contains(uri.scheme)) {
    throw const ProtocolException('HTTP 또는 HTTPS 주소를 입력하세요.');
  }
}
