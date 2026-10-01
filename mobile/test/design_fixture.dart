import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:iris_remote/design/sheet.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/agent_list_screen.dart';
import 'package:iris_remote/screens/agent_screen.dart';
import 'package:iris_remote/screens/browser_screen.dart';
import 'package:iris_remote/screens/human_turn_screen.dart';
import 'package:iris_remote/screens/permission_request_screen.dart';
import 'package:iris_remote/screens/question_request_screen.dart';
import 'package:iris_remote/screens/source_control_screen.dart';
import 'package:iris_remote/screens/terminal_screen.dart';
import 'package:iris_remote/state/remote_state.dart';

const permissionAgentRef = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const questionAgentRef = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const mobileAgentRef = 'cccccccccccccccccccccccccccccccc';
const modelAgentRef = 'dddddddddddddddddddddddddddddddd';
const documentAgentRef = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const humanAgentRef = 'ffffffffffffffffffffffffffffffff';
const restingAgentRef = '12121212121212121212121212121212';
const shellAgentRef = '13131313131313131313131313131313';
const dependencyAgentRef = '14141414141414141414141414141414';
const irisAgentSpaceRef = '10101010101010101010101010101010';
const labAgentSpaceRef = '20202020202020202020202020202020';
const shopAgentSpaceRef = '30303030303030303030303030303030';
const permissionRequestRef = '11111111111111111111111111111111';
const questionRequestRef = '22222222222222222222222222222222';
const humanRequestRef = '99999999999999999999999999999999';
const browserSpaceRef = '44444444444444444444444444444444';
const browserTabRef = '55555555555555555555555555555555';
const browserTabTwoRef = '66666666666666666666666666666666';
const gitFileRef = '77777777777777777777777777777777';

const designReferenceFontFamily = 'DesignReference';
late final Map<String, ui.Image> designFrameImages;

Future<void> loadDesignReferenceFont() async {
  final referenceLoader = FontLoader(designReferenceFontFamily);
  final koreanLoader = FontLoader('DesignReferenceKorean');
  final symbolLoader = FontLoader('DesignReferenceSymbols');
  final monoLoader = FontLoader('monospace');
  await _addFonts(referenceLoader, const [
    '/System/Library/Fonts/SFNS.ttf',
    '/System/Library/Fonts/SFNSItalic.ttf',
  ]);
  await _addFonts(koreanLoader, const [
    '/System/Library/Fonts/AppleSDGothicNeo.ttc',
  ]);
  await _addFonts(symbolLoader, const [
    '/System/Library/Fonts/Apple Symbols.ttf',
  ]);
  await _addFonts(monoLoader, const [
    '/System/Library/Fonts/SFNSMono.ttf',
    '/System/Library/Fonts/SFNSMonoItalic.ttf',
  ]);
  await referenceLoader.load();
  await koreanLoader.load();
  await symbolLoader.load();
  await monoLoader.load();
  designFrameImages = {
    for (final name in const [
      'page',
      'more',
      'selection',
      'record',
      'sketch',
      'direct',
      'desktop',
      'preview',
    ])
      name: await _decodeDesignFrame(name),
  };
}

Future<ui.Image> _decodeDesignFrame(String name) async {
  final bytes = File(
    'test/design_ref/frames/${name == 'page'
        ? 'browser-page'
        : name == 'direct'
        ? 'browser-direct'
        : name == 'more'
        ? 'browser-more'
        : name == 'selection'
        ? 'browser-selection'
        : name == 'record'
        ? 'browser-record'
        : name == 'sketch'
        ? 'browser-sketch'
        : name == 'desktop'
        ? 'browser-desktop'
        : 'human-preview'}.jpg',
  ).readAsBytesSync();
  final codec = await ui.instantiateImageCodec(bytes);
  return (await codec.getNextFrame()).image;
}

Future<void> _addFonts(FontLoader loader, List<String> paths) async {
  for (final path in paths) {
    final file = File(path);
    if (!file.existsSync()) continue;
    final bytes = await file.readAsBytes();
    loader.addFont(
      Future.value(ByteData.sublistView(Uint8List.fromList(bytes))),
    );
  }
}

ThemeData designTestTheme(Brightness brightness) {
  final theme = irisTheme(brightness);
  const fallbacks = ['DesignReferenceKorean', 'DesignReferenceSymbols'];
  return theme.copyWith(
    textTheme: theme.textTheme.apply(
      fontFamily: designReferenceFontFamily,
      fontFamilyFallback: fallbacks,
    ),
    primaryTextTheme: theme.primaryTextTheme.apply(
      fontFamily: designReferenceFontFamily,
      fontFamilyFallback: fallbacks,
    ),
  );
}

int minutesAgo(int minutes) =>
    DateTime.now().millisecondsSinceEpoch - minutes * 60000;

RemoteAgent designAgent({
  required String ref,
  required String name,
  required String kind,
  required String status,
  required String space,
  required int minutes,
  bool question = false,
  String? parent,
  int? sessionOrder,
}) => RemoteAgent(
  ref: ref,
  name: name,
  kind: kind,
  status: status,
  question: question,
  space: space,
  spaceRef: switch (space) {
    'iris' => irisAgentSpaceRef,
    'agent-lab' => labAgentSpaceRef,
    'shop' => shopAgentSpaceRef,
    _ => '40404040404040404040404040404040',
  },
  spaceOrder: switch (space) {
    'iris' => 0,
    'agent-lab' => 1,
    'shop' => 2,
    _ => 3,
  },
  sessionOrder: sessionOrder ?? minutes,
  parent: parent,
  lastActivityAt: minutesAgo(minutes),
  can: const AgentPermissions(stop: true, message: true),
);

List<RemoteAgent> designAgents() => [
  designAgent(
    ref: permissionAgentRef,
    name: 'Orca-Diff',
    kind: 'codex',
    status: 'blocked',
    space: 'iris',
    minutes: 0,
  ),
  designAgent(
    ref: questionAgentRef,
    name: '블로그 초안',
    kind: 'claude',
    status: 'working',
    question: true,
    space: 'agent-lab',
    minutes: 4,
  ),
  designAgent(
    ref: mobileAgentRef,
    name: '모바일 화면 수정',
    kind: 'claude',
    status: 'working',
    space: 'iris',
    minutes: 2,
  ),
  designAgent(
    ref: modelAgentRef,
    name: '모델 비교 실험',
    kind: 'claude',
    status: 'working',
    space: 'agent-lab',
    minutes: 40,
  ),
  designAgent(
    ref: humanAgentRef,
    name: '결제 흐름 점검',
    kind: 'claude',
    status: 'blocked',
    space: 'shop',
    minutes: 6,
  ),
  designAgent(
    ref: restingAgentRef,
    name: '검색 색인 재작성',
    kind: 'codex',
    status: 'done',
    space: 'iris',
    minutes: 12,
    parent: mobileAgentRef,
  ),
  designAgent(
    ref: shellAgentRef,
    name: 'shell',
    kind: 'codex',
    status: 'idle',
    space: 'agent-lab',
    minutes: 24 * 60,
  ),
  designDependencyAgent(),
];

RemoteAgent designDependencyAgent() => designAgent(
  ref: dependencyAgentRef,
  name: '의존성 정리',
  kind: 'codex',
  status: 'question',
  question: true,
  space: 'iris',
  minutes: 9,
);

RemoteAgent designDocumentAgent() => designAgent(
  ref: documentAgentRef,
  name: '문서 정리',
  kind: 'claude',
  status: 'working',
  space: 'iris',
  minutes: 1,
);

RemoteAgent designTerminalShellAgent() => designAgent(
  ref: shellAgentRef,
  name: 'shell',
  kind: 'codex',
  status: 'idle',
  space: 'iris',
  minutes: 24 * 60,
);

RemoteRequest designPermissionRequest() => RemoteRequest(
  ref: permissionRequestRef,
  agent: permissionAgentRef,
  kind: 'permission',
  createdAt: minutesAgo(0),
  expiresAt: minutesAgo(0) + 600000,
  body: const PermissionRequestBody(
    tool: 'Bash',
    description: '명령 실행',
    input: 'pnpm test -- server/worktree-handlers',
  ),
);

RemoteRequest designHomeQuestionRequest() => RemoteRequest(
  ref: questionRequestRef,
  agent: questionAgentRef,
  kind: 'question',
  createdAt: minutesAgo(4),
  expiresAt: minutesAgo(4) + 600000,
  body: const QuestionRequestBody([
    RequestQuestion(
      question: '표 두 개를 어떻게 둘까요?',
      header: '표 배치',
      multiSelect: false,
      options: [
        RequestOption(label: '하나로 합치기', description: ''),
        RequestOption(label: '기간별로', description: ''),
      ],
    ),
  ]),
);

RemoteRequest designSheetQuestionRequest() => RemoteRequest(
  ref: '33333333333333333333333333333333',
  agent: dependencyAgentRef,
  kind: 'question',
  createdAt: minutesAgo(9),
  expiresAt: minutesAgo(9) + 600000,
  body: const QuestionRequestBody([
    RequestQuestion(
      question: '어떤 패키지를 올릴까요?',
      header: '패키지',
      multiSelect: true,
      options: [
        RequestOption(label: 'vite 6 → 7', description: '빌드 설정 2곳을 고쳐야 합니다'),
        RequestOption(label: 'electron 38 → 39', description: '앱을 다시 빌드해야 합니다'),
        RequestOption(label: 'xterm 5.5 → 6', description: '터미널 렌더러 API가 바뀝니다'),
        RequestOption(label: '직접 입력', description: ''),
      ],
    ),
    RequestQuestion(
      question: '잠금 파일을 새로 만들까요?',
      header: '잠금 파일',
      multiSelect: false,
      options: [
        RequestOption(label: '기존 파일 유지', description: '바뀐 패키지만 갱신합니다'),
        RequestOption(label: '새로 만들기', description: '모든 하위 의존성이 최신이 됩니다'),
      ],
    ),
  ]),
);

RemoteRequest designHomeDependencyQuestionRequest() => RemoteRequest(
  ref: '33333333333333333333333333333333',
  agent: dependencyAgentRef,
  kind: 'question',
  createdAt: minutesAgo(9),
  expiresAt: minutesAgo(9) + 600000,
  body: const QuestionRequestBody([
    RequestQuestion(
      question: '어떤 패키지를 올릴지, 잠금 파일을 새로 만들지',
      header: '패키지',
      multiSelect: true,
      options: [],
    ),
    RequestQuestion(
      question: '잠금 파일을 새로 만들까요?',
      header: '잠금 파일',
      multiSelect: false,
      options: [],
    ),
  ]),
);

AgentHomeView designHome({bool extended = true, bool withRequests = true}) =>
    AgentHomeView(
      agents: designAgents(),
      requests: !withRequests
          ? const []
          : extended
          ? [
              designPermissionRequest(),
              designHomeQuestionRequest(),
              designHumanRequest(),
              designHomeDependencyQuestionRequest(),
            ]
          : [designPermissionRequest(), designHomeQuestionRequest()],
      connectionName: 'MacBook Pro',
      browserSpaces: extended
          ? const [BrowserSpace(ref: browserSpaceRef, name: 'shop')]
          : const [],
      browserTabs: extended
          ? const [
              BrowserTab(
                ref: browserTabRef,
                space: browserSpaceRef,
                title: 'shop.test',
                url: 'https://shop.test/checkout',
                profile: '기본',
                aiControlled: true,
                controlling: ['결제 흐름 점검'],
                active: true,
                sleeping: false,
              ),
              BrowserTab(
                ref: browserTabTwoRef,
                space: browserSpaceRef,
                title: 'GitHub',
                url: 'https://github.com/example/iris/pull/39',
                profile: '업무',
                aiControlled: false,
                controlling: [],
                active: false,
                sleeping: false,
              ),
            ]
          : const [],
      onOpenAgent: (_) {},
      onAnswerPermission: (_, _) async =>
          const RequestAnswerResult(rid: 'fixture', result: 'delivered'),
      onAnswerQuestion: (_, _, _) async =>
          const RequestAnswerResult(rid: 'fixture', result: 'delivered'),
      onOpenRequest: (_, _) async {},
      onOpenBrowserTab: extended ? (_) {} : null,
      onAnswerHuman: (_, _) async =>
          const RequestAnswerResult(rid: 'fixture', result: 'delivered'),
      onSettings: () {},
    );

AgentSessionView designSession() {
  final agents = designAgents();
  final activeAgent = designAgent(
    ref: permissionAgentRef,
    name: 'Orca-Diff',
    kind: 'codex',
    status: 'blocked',
    space: 'iris',
    minutes: 0,
  );
  return AgentSessionView(
    agent: activeAgent,
    spaceAgents: [activeAgent, designDocumentAgent(), agents[2]],
    transcript: const [
      TranscriptItem(role: 'user', text: 'worktree 목록 높이를 줄이고 검사까지 돌려 줘'),
      TranscriptItem(
        role: 'assistant',
        text: '줄 구조를 한 줄로 바꾸고 PR 상태를 글자로 적었습니다.',
      ),
      TranscriptItem(
        role: 'tool',
        tool: 'pnpm lint',
        text:
            '…\n✓ 212 files checked\n✓ no problems\n'
            'line 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\n'
            'line 11\nline 12\nline 13\nline 14\nline 15\nline 16\nline 17\n'
            'line 18\nline 19\nline 20\nline 21\nline 22\nline 23\nline 24\n'
            'line 25\nline 26\nline 27\nline 28\nline 29\nline 30\nline 31\n'
            'line 32\nline 33\nline 34\nline 35\nline 36\nline 37\nline 38',
      ),
      TranscriptItem(role: 'assistant', text: '이제 서버 쪽 검사를 실행하겠습니다.'),
    ],
    onBack: () {},
    onSelectAgent: (_) {},
    onSend: (_) async => true,
    onStop: () async {},
    onTerminal: () {},
    onBrowser: () {},
    onGitHub: () {},
    githubFailed: true,
    canMessage: true,
    modelLabel: 'gpt-5.5',
    workingLabel: '작업 중 · 3분 02초',
  );
}

AgentSessionView designQuestionBackground() {
  final agent = designAgent(
    ref: permissionAgentRef,
    name: '의존성 정리',
    kind: 'codex',
    status: 'question',
    question: true,
    space: 'iris',
    minutes: 9,
  );
  return AgentSessionView(
    agent: agent,
    spaceAgents: designSession().spaceAgents,
    transcript: const [
      TranscriptItem(role: 'user', text: '패키지 업데이트 정리해 줘'),
      TranscriptItem(
        role: 'assistant',
        text: '올릴 수 있는 패키지를 찾았습니다. 두 가지를 정해 주세요.',
      ),
    ],
    onBack: () {},
    onSelectAgent: (_) {},
    onSend: (_) async => true,
    onTerminal: () {},
    onBrowser: () {},
    onGitHub: () {},
    githubFailed: true,
    showDeliveryStatus: false,
    canMessage: true,
  );
}

IrisSheetScene designPermissionScene() => IrisSheetScene(
  sheetKey: const Key('permission-sheet'),
  background: designSession(),
  sheet: PermissionRequestSheet(
    request: designPermissionRequest(),
    agentName: 'Orca-Diff',
    agentKind: 'codex',
    space: 'iris',
    onAnswer: (_) async =>
        const RequestAnswerResult(rid: 'fixture', result: 'delivered'),
  ),
);

IrisSheetScene designQuestionScene({
  Future<RequestAnswerResult> Function(List<QuestionResponse>)? onAnswer,
}) => IrisSheetScene(
  sheetKey: const Key('question-sheet'),
  background: designQuestionBackground(),
  sheet: QuestionRequestSheet(
    request: designSheetQuestionRequest(),
    agentName: '의존성 정리',
    agentKind: 'codex',
    space: 'iris',
    onAnswer:
        onAnswer ??
        (_) async =>
            const RequestAnswerResult(rid: 'fixture', result: 'delivered'),
  ),
);

RemoteRequest designHumanRequest() => RemoteRequest(
  ref: humanRequestRef,
  agent: humanAgentRef,
  kind: 'browser-user',
  createdAt: minutesAgo(6),
  expiresAt: minutesAgo(6) + 600000,
  body: const BrowserUserRequestBody(
    title: '카드 인증 화면은 직접 진행해 주세요',
    text: '에이전트는 기다리는 중입니다. 탭을 열어 인증을 마친 뒤 결과를 골라 주세요.',
    choices: ['다 했음', '못 하겠음'],
    tab: browserTabRef,
  ),
);

const designGitFile = GitFileChange(
  ref: gitFileRef,
  path: 'web/js/worktrees/worktree-row.js',
  code: 'M',
  staged: false,
  untracked: false,
  additions: 12,
  deletions: 5,
);

const designGitChanges = GitChangesResult(
  rid: 'fixture',
  branch: 'feat/worktree-row',
  ahead: 2,
  behind: 0,
  base: 'main',
  commitCount: 3,
  additions: 84,
  deletions: 31,
  files: [
    designGitFile,
    GitFileChange(
      ref: '88888888888888888888888888888888',
      path: 'web/css/38-worktrees.css',
      code: 'M',
      staged: false,
      untracked: false,
      additions: 9,
      deletions: 14,
    ),
    GitFileChange(
      ref: '89898989898989898989898989898989',
      path: 'server/worktree-list.test.js',
      code: 'A',
      staged: true,
      untracked: false,
      additions: 41,
      deletions: 0,
    ),
    GitFileChange(
      ref: '90909090909090909090909090909090',
      path: 'server/worktree-handlers.js',
      code: 'M',
      staged: false,
      untracked: false,
      additions: 18,
      deletions: 6,
    ),
    GitFileChange(
      ref: '91919191919191919191919191919191',
      path: 'web/js/worktrees/row-legacy.js',
      code: 'D',
      staged: false,
      untracked: false,
      additions: 0,
      deletions: 4,
    ),
    GitFileChange(
      ref: '92929292929292929292929292929292',
      path: 'web/js/worktrees/list.js',
      code: 'M',
      staged: false,
      untracked: false,
      additions: 2,
      deletions: 1,
    ),
    GitFileChange(
      ref: '93939393939393939393939393939393',
      path: 'test/worktree-remote.test.js',
      code: 'A',
      staged: false,
      untracked: true,
      additions: 2,
      deletions: 1,
    ),
  ],
  bases: ['main'],
);

const designPr = GitHubPrResult(
  rid: 'fixture',
  pr: GitHubPullRequest(
    number: 412,
    title: '폰 앱에 시안 v6 나머지 화면 연결',
    state: 'OPEN',
    isDraft: false,
    head: 'mobile-v6',
    base: 'main',
    author: 'demo',
    reviewComments: [
      GitHubReviewComment(
        author: 'reviewer',
        body: '좌표 변환에서 데스크톱 프레임 크기도 확인해 주세요.',
        path: 'mobile/lib/screens/browser_screen.dart',
        line: 214,
      ),
    ],
    checks: [
      GitHubCheck(
        name: 'server-tests',
        conclusion: 'failure',
        status: 'completed',
        detailsUrl: 'https://github.com/example/iris/actions/runs/123',
        runId: '123',
      ),
      GitHubCheck(
        name: 'analyze',
        conclusion: 'success',
        status: 'completed',
        detailsUrl: 'https://github.com/example/iris/actions/runs/124',
        runId: '124',
      ),
    ],
  ),
);

const designDiff = GitDiffResult(
  rid: 'fixture',
  file: gitFileRef,
  patch:
      '@@ -44,9 +44,16 @@ export function renderRow(tree)\n'
      ' const name = tree.branch;\n'
      ' const pr = prLabel(tree);\n'
      '- row.append(nameEl(name), badge(pr));\n'
      '+ row.className = "wt-row one-line";\n'
      '+ row.append(nameEl(name));\n'
      '+ row.append(text(pr.label));\n'
      '+ row.title = name + " · " + pr.label;\n'
      ' return row;',
  truncated: false,
);

const designCheckLog = GitHubCheckLogResult(
  rid: 'fixture',
  run: '123',
  log:
      '▸ pnpm test -- server/\n'
      '✗ worktree-list › 긴 브랜치 이름\n'
      '  expected "feat/very-long-bra…"\n'
      '  received "feat/very-long-branch-name-for-row"\n'
      '  at server/worktree-list.test.js:27\n'
      '1 failed, 211 passed',
  truncated: false,
);

const designTerminalKeys = <TerminalKeyButton>[
  TerminalKeyButton(
    id: 'esc',
    label: '중단',
    key: 'Escape',
    modifiers: KeyModifiers(),
  ),
  TerminalKeyButton(
    id: 'ctrl-c',
    label: '모드 전환',
    key: 'Tab',
    modifiers: KeyModifiers(shift: true),
  ),
  TerminalKeyButton(
    id: 'tab',
    label: '취소',
    key: 'c',
    modifiers: KeyModifiers(ctrl: true),
  ),
  TerminalKeyButton(
    id: 'up',
    label: '이전 입력',
    key: 'ArrowUp',
    modifiers: KeyModifiers(),
  ),
  TerminalKeyButton(
    id: 'enter',
    label: '압축',
    key: '/compact',
    modifiers: KeyModifiers(),
  ),
  TerminalKeyButton(
    id: 'auto-complete',
    label: '자동 완성',
    key: 'Tab',
    modifiers: KeyModifiers(),
  ),
  TerminalKeyButton(
    id: 'search',
    label: '기록 검색',
    key: 'r',
    modifiers: KeyModifiers(ctrl: true),
  ),
  TerminalKeyButton(
    id: 'newline',
    label: '줄바꿈',
    key: 'Enter',
    modifiers: KeyModifiers(alt: true),
  ),
  TerminalKeyButton(
    id: 'clear',
    label: '대화 비우기',
    key: '/clear',
    modifiers: KeyModifiers(),
  ),
  TerminalKeyButton(
    id: 'status',
    label: '상태',
    key: 'git status',
    modifiers: KeyModifiers(),
  ),
];

Widget designHumanScene(DesignRemote remote) {
  remote.connection.frameKind = 'preview';
  return IrisSheetScene(
    sheetKey: const Key('human-turn-scene'),
    background: designHumanBackground(),
    sheet: HumanTurnSheet(
      state: remote.state,
      request: designHumanRequest(),
      agent: designAgents()[4],
      onOpenTab: () {},
      previewImage: designFrameImages['preview'],
      previewUrl: 'https://shop.test/checkout/verify',
    ),
  );
}

AgentSessionView designHumanBackground() {
  final agents = designSession().spaceAgents;
  final agent = designAgents()[4];
  return AgentSessionView(
    agent: agent,
    spaceAgents: agents,
    transcript: const [
      TranscriptItem(
        role: 'assistant',
        text: '결제 버튼까지 확인했습니다. 카드 인증은 직접 해야 합니다.',
      ),
    ],
    onBack: () {},
    onSelectAgent: (_) {},
    onSend: (_) async => true,
    onTerminal: () {},
    onBrowser: () {},
    onGitHub: () {},
    githubFailed: true,
    canMessage: true,
  );
}

Widget designBrowserScene(
  DesignRemote remote, {
  bool human = false,
  String frame = 'page',
}) {
  remote.connection.frameKind = human ? 'direct' : 'page';
  return BrowserScreen(
    state: remote.state,
    agentRef: humanAgentRef,
    tabRef: browserTabRef,
    humanRequest: human ? designHumanRequest() : null,
    frameIncludesOverlays: true,
    frameImage: designFrameImages[human ? 'direct' : frame],
    selectionFrameImage: designFrameImages['selection'],
    recordFrameImage: designFrameImages['record'],
    sketchFrameImage: designFrameImages['sketch'],
    desktopFrameImage: designFrameImages['desktop'],
    elementComponent: 'CheckoutButton',
    elementSource: 'src/Checkout.tsx:88',
    profileDetails: const {
      '기본': 'kim@example.com · 로그인 3곳',
      '업무': 'user@example.com · 로그인 11곳',
    },
    showChromeImport: true,
    overlayBuilder: (_, tool) => _designBrowserOverlay(tool),
  );
}

Widget _designBrowserOverlay(BrowserTool tool) => Stack(
  fit: StackFit.expand,
  children: switch (tool) {
    BrowserTool.pick => [
      Positioned(
        left: 14,
        top: 286,
        child: Container(
          height: 24,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: const Color(0xff00aff0),
            borderRadius: BorderRadius.circular(6),
          ),
          child: const Text(
            'button.pay · CheckoutButton',
            style: TextStyle(
              color: Color(0xff06121b),
              fontFamily: 'monospace',
              fontSize: 11.5,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ),
    ],
    BrowserTool.record => [
      for (final entry in const [(356.0, 280.0, '1'), (356.0, 344.0, '2')])
        Positioned(
          left: entry.$1,
          top: entry.$2,
          child: Container(
            width: 24,
            height: 24,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: const Color(0xffff7a72),
              shape: BoxShape.circle,
              boxShadow: [
                BoxShadow(
                  color: const Color(0xffff7a72).withValues(alpha: 0.3),
                  spreadRadius: 3,
                ),
              ],
            ),
            child: Text(
              entry.$3,
              style: const TextStyle(
                color: Color(0xff1a0806),
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ),
    ],
    BrowserTool.sketch => [
      const Positioned(
        left: 300,
        top: 238,
        child: Text(
          '더 크게',
          style: TextStyle(
            color: Color(0xffff7a72),
            fontSize: 18,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
    ],
    BrowserTool.none => [
      Positioned(
        left: 114.5,
        right: 114.5,
        bottom: 14,
        child: Container(
          height: 32,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            color: const Color(0xff3e3638),
            borderRadius: BorderRadius.circular(16),
          ),
          child: Row(
            children: [
              Container(
                width: 7,
                height: 7,
                decoration: const BoxDecoration(
                  color: Color(0xfff4a1a7),
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 8),
              const Text(
                '결제 흐름 점검이 입력 중',
                style: TextStyle(
                  color: Color(0xffffd9dc),
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
      ),
    ],
    _ => const [],
  },
);

Widget designTerminalScene(DesignRemote remote) => TerminalScreen(
  state: remote.state,
  agentRef: permissionAgentRef,
  githubFailed: true,
);

Widget designKeySettings() => TerminalKeySettingsScreen(
  macName: 'MacBook Pro',
  otherMacNames: const ['Mac Studio'],
  keys: designTerminalKeys,
  onAdd: (_) async => null,
);

Widget designKeyEditorBackground() => TerminalKeySettingsScreen(
  macName: 'MacBook Pro',
  otherMacNames: const ['Mac Studio'],
  keys: designTerminalKeys,
  initiallyEditing: true,
  onAdd: (_) async => null,
);

Widget designKeyEditorScene() => IrisSheetScene(
  sheetKey: const Key('key-editor-scene'),
  background: designKeyEditorBackground(),
  sheet: const TerminalKeyEditorSheet(
    initialName: '기록 검색',
    initialKey: 'R',
    initialCtrl: true,
    macName: 'MacBook Pro',
  ),
);

Widget designSourceControlScene(DesignRemote remote) => IrisSheetScene(
  sheetKey: const Key('source-control-scene'),
  background: designSession(),
  sheet: SourceControlSheet(
    session: remote.session,
    agent: designAgents().first,
    initialChanges: designGitChanges,
    initialPr: designPr,
    onOpenDiff: (_) {},
  ),
);

Widget designDiffScene(DesignRemote remote) => GitDiffScreen(
  session: remote.session,
  agent: designAgents().first,
  file: designGitFile,
  initialDiff: designDiff,
);

Widget designCheckFailureScene(DesignRemote remote) => IrisSheetScene(
  sheetKey: const Key('check-failure-scene'),
  background: designSession(),
  sheet: CheckFailureSheet(
    session: remote.session,
    agent: designAgents().first,
    check: designPr.pr.checks.first,
    log: designCheckLog,
    branch: designGitChanges.branch,
    base: designGitChanges.base,
  ),
);

class DesignRemoteScene extends StatefulWidget {
  const DesignRemoteScene({required this.builder, super.key});

  final Widget Function(BuildContext context, DesignRemote remote) builder;

  @override
  State<DesignRemoteScene> createState() => _DesignRemoteSceneState();
}

class _DesignRemoteSceneState extends State<DesignRemoteScene> {
  late final DesignRemote remote = DesignRemote();

  @override
  void initState() {
    super.initState();
    unawaited(remote.state.initialize());
  }

  @override
  void dispose() {
    remote.state.dispose();
    unawaited(remote.session.disconnect());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: remote.state,
    builder: (context, _) {
      if (remote.state.agent(permissionAgentRef) == null ||
          remote.state.browserTab(browserTabRef) == null) {
        return const Scaffold(body: SizedBox.expand());
      }
      return widget.builder(context, remote);
    },
  );
}

class DesignRemote {
  factory DesignRemote() {
    final connection = DesignRemoteConnection();
    late DesignRemote value;
    final session = ActiveRemoteSession.attach(
      macName: 'MacBook Pro',
      capabilities: designCapabilities,
      connection: connection,
      pingInterval: const Duration(days: 1),
      resumeToken: 'r' * 43,
      resume: (_) => value._resume(),
    );
    value = DesignRemote._(connection, session);
    return value;
  }

  DesignRemote._(this.connection, this.session) {
    state = RemoteState(session);
  }

  final DesignRemoteConnection connection;
  final ActiveRemoteSession session;
  late final RemoteState state;
  Completer<void>? resumeGate;
  DesignRemoteConnection? resumedConnection;

  Future<ResumedRemoteConnection> _resume() async {
    await resumeGate?.future;
    final next = DesignRemoteConnection();
    resumedConnection = next;
    return ResumedRemoteConnection(
      connection: next,
      capabilities: const Capabilities(
        macName: 'MacBook Pro',
        requests: designCapabilities,
      ),
      resumeToken: 's' * 43,
    );
  }
}

const designCapabilities = <String>[
  'watch',
  'request.answer',
  'agent.message',
  'terminal.watch',
  'terminal.input',
  'terminal.key',
  'terminal.keys.get',
  'terminal.keys.set',
  'browser.tabs',
  'browser.frame.watch',
  'browser.pointer',
  'browser.mouse',
  'browser.type',
  'browser.key',
  'browser.scroll',
  'browser.history',
  'browser.navigate',
  'browser.tab.new',
  'browser.element',
  'browser.element.hover',
  'browser.element.pick',
  'browser.element.send',
  'browser.focus',
  'browser.dialog',
  'browser.record.start',
  'browser.record.pause',
  'browser.record.finish',
  'browser.sketch.send',
  'browser.draft.remove',
  'browser.profiles',
  'browser.profile.set',
  'browser.desktop',
  'browser.translate',
  'browser.bookmarks',
  'browser.bookmark.set',
  'browser.direct',
  'git.changes',
  'git.diff',
  'git.diff.draft',
  'github.pr',
  'github.check.log',
  'github.check.draft',
];

class DesignRemoteConnection implements RemoteConnection {
  DesignRemoteConnection() {
    last = this;
  }

  static late DesignRemoteConnection last;
  String frameKind = 'page';
  bool browserFocusEditable = false;
  BrowserDialog? browserDialog;
  Completer<void>? browserHoverGate;
  int browserDialogGetDelay = 0;
  String agentMessageResult = 'delivered';
  List<String> browserProfiles = const ['기본', '업무'];
  final StreamController<String> _incoming = StreamController<String>();
  final List<Map<String, Object>> sent = [];
  final Completer<void> _closed = Completer<void>();
  late final StreamIterator<String> _iterator = StreamIterator(
    _incoming.stream,
  );

  @override
  Future<void> get closed => _closed.future;

  @override
  void sendJson(Map<String, Object> message) {
    sent.add(Map<String, Object>.from(message));
    final rid = message['rid'];
    final type = message['type'];
    switch (type) {
      case 'watch':
        _later(_agentsMessage());
        _later(_requestsMessage());
      case 'agent.message':
        _later({
          'type': 'agent.message.result',
          'rid': rid!,
          'result': agentMessageResult,
        });
      case 'browser.tabs':
        _later(_browserTabs(rid! as String));
      case 'browser.frame.watch':
        _later({
          'type': 'browser.frame.watch.result',
          'rid': rid!,
          'tab': message['tab']!,
          'watching': true,
        });
        _later({
          'type': 'browser.frame',
          'tab': message['tab']!,
          'seq': 1,
          'width': message['width']!,
          'height': 648,
          'jpeg': _designFrame(
            message['desktop'] == true ? 'desktop' : frameKind,
          ),
        });
      case 'terminal.watch':
        _later({
          'type': 'terminal.watch.result',
          'rid': rid!,
          'agent': message['agent']!,
          'revision': 7,
          'text':
              '\x1b[90m› worktree 목록 높이를 줄이고 검사까지 돌려 줘\x1b[0m'
              '\n\n\x1b[32m•\x1b[0m Edited web/css/38-worktrees.css \x1b[32m+12\x1b[0m \x1b[31m-40\x1b[0m'
              '\n\x1b[32m•\x1b[0m Ran pnpm test -- server/worktree-handlers'
              '\n\x1b[90m  └ 31 passed · 0 failed · 4.2s\x1b[0m'
              '\n\x1b[32m•\x1b[0m 검사가 통과했습니다. 커밋할까요?'
              '\n\n\x1b[34m›\x1b[0m ',
          'truncated': false,
        });
      case 'terminal.keys.get':
      case 'terminal.keys.set':
        _later(_terminalKeys(rid! as String, message['keys']));
      case 'browser.element':
        _later({
          'type': 'browser.element.result',
          'rid': rid!,
          'element': {
            'selector': 'button.pay',
            'text': '39,000원 결제',
            'rect': {'x': 248, 'y': 392, 'width': 124, 'height': 48},
          },
        });
      case 'browser.element.hover':
        final response = <String, Object?>{
          'type': 'browser.element.hover.result',
          'rid': rid!,
          'viewport': {'width': 394, 'height': 648},
          'element': {
            'selector': 'button.pay',
            'text': '39,000원 결제',
            'rect': {'x': 248, 'y': 392, 'width': 124, 'height': 48},
          },
        };
        final gate = browserHoverGate;
        if (gate == null) {
          _later(response);
        } else {
          unawaited(gate.future.then((_) => _later(response)));
        }
      case 'browser.element.pick':
        _later({
          'type': 'browser.draft.result',
          'rid': rid!,
          'ref': '6' * 32,
          'kind': 'element',
          'summary': '39,000원 결제',
          'content': '⟦Iris⟧ 요소 선택 #p1 · 탭 결제 · https://shop.test/checkout\n선택자: button.pay\n⟦/Iris⟧',
        });
      case 'browser.focus':
        _later({
          'type': 'browser.focus.result',
          'rid': rid!,
          'editable': browserFocusEditable,
          'kind': browserFocusEditable ? 'text' : 'none',
          'multiline': false,
          'selectedText': '',
        });
      case 'browser.dialog':
        final delayed = message['action'] == 'get' && browserDialogGetDelay > 0;
        if (delayed) browserDialogGetDelay--;
        final current = delayed ? null : browserDialog;
        if (message['action'] != 'get') browserDialog = null;
        _later({
          'type': 'browser.dialog.result',
          'rid': rid!,
          'dialog': message['action'] == 'get' && current != null
              ? {'kind': current.kind, 'message': current.message}
              : null,
        });
      case 'browser.record.start':
        _later({
          'type': 'browser.record.result',
          'rid': rid!,
          'state': 'recording',
          'elapsedMs': 24000,
          'steps': [
            '이메일 칸에 입력 · input#email',
            '카드 번호 칸 누름 · input#card',
            '결제 버튼 누름 · button.pay',
          ],
        });
      case 'browser.record.pause':
        _later({
          'type': 'browser.record.result',
          'rid': rid!,
          'state': message['paused'] == true ? 'paused' : 'recording',
          'elapsedMs': 24000,
          'steps': [
            '이메일 칸에 입력 · input#email',
            '카드 번호 칸 누름 · input#card',
            '결제 버튼 누름 · button.pay',
          ],
        });
      case 'browser.record.finish':
        _later({
          'type': 'browser.draft.result',
          'rid': rid!,
          'ref': '8' * 32,
          'kind': 'record',
          'summary': '3단계',
          'content': '[폰 브라우저 조작 기록]\n1. 이메일 칸에 입력\n2. 카드 번호 칸 누름\n3. 결제 버튼 누름',
        });
      case 'browser.element.send':
        _later({
          'type': 'browser.draft.result',
          'rid': rid!,
          'ref': '7' * 32,
          'kind': 'element',
          'summary': '39,000원 결제',
          'content': '[브라우저 요소]\n선택자: button.pay\n글자: 39,000원 결제\n\n확인',
        });
      case 'browser.sketch.send':
        _later({
          'type': 'browser.draft.result',
          'rid': rid!,
          'ref': '9' * 32,
          'kind': 'sketch',
          'summary': '결제',
          'content': '[폰 화면 스케치]\n대상: 결제\n그림: Mac에 저장됨\n\n확인',
        });
      case 'browser.profiles':
        _later({
          'type': 'browser.profiles.result',
          'rid': rid!,
          'profiles': browserProfiles,
        });
      case 'browser.bookmarks':
        _later({
          'type': 'browser.bookmarks.result',
          'rid': rid!,
          'bookmarks': [
            {
              'title': '결제',
              'url': 'https://shop.test/checkout',
              'folder': null,
            },
          ],
        });
      case 'git.changes':
        _later(_gitChanges(rid! as String));
      case 'git.diff':
        _later({
          'type': 'git.diff.result',
          'rid': rid!,
          'file': gitFileRef,
          'patch': designDiff.patch,
          'truncated': false,
        });
      case 'github.pr':
        _later(_githubPr(rid! as String));
      case 'github.check.log':
        _later({
          'type': 'github.check.log.result',
          'rid': rid!,
          'run': message['run']!,
          'log': designCheckLog.log,
          'truncated': false,
        });
      case 'request.answer':
        _later({
          'type': 'request.answer.result',
          'rid': rid!,
          'result': 'delivered',
        });
      case 'browser.pointer':
      case 'browser.mouse':
      case 'browser.type':
      case 'browser.key':
      case 'browser.scroll':
      case 'browser.history':
      case 'browser.navigate':
      case 'browser.tab.new':
      case 'browser.draft.remove':
      case 'browser.profile.set':
      case 'browser.desktop':
      case 'browser.translate':
      case 'browser.bookmark.set':
      case 'browser.direct':
      case 'terminal.input':
      case 'terminal.key':
      case 'git.diff.draft':
      case 'github.check.draft':
        _later({'type': 'remote.action.result', 'rid': rid!, 'result': 'done'});
    }
  }

  void _later(Map<String, Object?> message) {
    scheduleMicrotask(() {
      if (!_incoming.isClosed) _incoming.add(jsonEncode(message));
    });
  }

  void fail([Object error = const FormatException('connection-closed')]) {
    _incoming.addError(error);
  }

  @override
  Future<String> receive() async {
    if (await _iterator.moveNext()) return _iterator.current;
    throw StateError('closed');
  }

  @override
  Future<void> close() async {
    if (!_closed.isCompleted) _closed.complete();
    unawaited(_iterator.cancel().catchError((_) {}));
    unawaited(_incoming.close().catchError((_) {}));
  }
}

Map<String, Object?> _agentsMessage() => {
  'type': 'agents',
  'agents': [
    for (final agent in [
      designAgents().first,
      designDocumentAgent(),
      designAgents()[2],
      designTerminalShellAgent(),
      designAgents()[4],
    ])
      {
        'ref': agent.ref,
        'name': agent.name,
        'kind': agent.kind,
        'status': agent.status,
        'question': agent.question,
        'space': agent.space,
        'spaceRef': agent.spaceRef,
        'spaceOrder': agent.spaceOrder,
        'sessionOrder': agent.sessionOrder,
        'parent': agent.parent,
        'lastActivityAt': agent.lastActivityAt,
        'can': {'stop': agent.can.stop, 'message': agent.can.message},
      },
  ],
};

Map<String, Object?> _requestsMessage() => {
  'type': 'requests',
  'requests': [
    {
      'ref': humanRequestRef,
      'agent': humanAgentRef,
      'kind': 'browser-user',
      'createdAt': minutesAgo(6),
      'expiresAt': minutesAgo(6) + 600000,
      'body': {
        'title': '카드 인증 화면은 직접 진행해 주세요',
        'text': '에이전트는 기다리는 중입니다. 탭을 열어 인증을 마친 뒤 결과를 골라 주세요.',
        'choices': ['다 했음', '못 하겠음'],
        'tab': browserTabRef,
      },
    },
  ],
};

Map<String, Object?> _browserTabs(String rid) => {
  'type': 'browser.tabs.result',
  'rid': rid,
  'spaces': [
    {'ref': irisAgentSpaceRef, 'name': 'iris'},
  ],
  'tabs': [
    {
      'ref': browserTabRef,
      'space': irisAgentSpaceRef,
      'title': 'shop.test',
      'url': 'https://shop.test/checkout',
      'profile': '기본',
      'aiControlled': true,
      'controlling': ['Orca-Diff'],
      'sessions': [permissionAgentRef],
      'active': true,
      'sleeping': false,
    },
    {
      'ref': browserTabTwoRef,
      'space': irisAgentSpaceRef,
      'title': 'GitHub',
      'url': 'https://docs.test',
      'profile': '업무',
      'aiControlled': false,
      'controlling': <String>[],
      'sessions': <String>[],
      'active': false,
      'sleeping': false,
    },
  ],
};

Map<String, Object?> _terminalKeys(String rid, Object? sent) => {
  'type': 'terminal.keys',
  'rid': rid,
  'keys':
      sent ??
      [
        _key('esc', '중단', 'Escape'),
        _key('mode', '모드 전환', 'Tab', shift: true),
        _key('ctrl-c', '취소', 'c', ctrl: true),
        _key('up', '이전 입력', 'ArrowUp'),
        _key('compact', '압축', '/compact'),
        _key('auto-complete', '자동 완성', 'Tab'),
        _key('search', '기록 검색', 'r', ctrl: true),
        _key('newline', '줄바꿈', 'Enter', alt: true),
        _key('clear', '대화 비우기', '/clear'),
        _key('status', '상태', 'git status'),
      ],
  'defaults': <Object>[],
  'macShortcuts': [
    {'id': 'search', 'label': '검색', 'keys': '⌘F'},
  ],
};

Map<String, Object?> _key(
  String id,
  String label,
  String key, {
  bool ctrl = false,
  bool alt = false,
  bool shift = false,
}) => {
  'id': id,
  'label': label,
  'key': key,
  'modifiers': {'ctrl': ctrl, 'alt': alt, 'shift': shift, 'cmd': false},
};

Map<String, Object?> _gitChanges(String rid) => {
  'type': 'git.changes.result',
  'rid': rid,
  'branch': designGitChanges.branch,
  'ahead': designGitChanges.ahead,
  'behind': designGitChanges.behind,
  'base': designGitChanges.base,
  'commitCount': designGitChanges.commitCount,
  'additions': designGitChanges.additions,
  'deletions': designGitChanges.deletions,
  'files': [
    for (final file in designGitChanges.files)
      {
        'ref': file.ref,
        'path': file.path,
        'code': file.code,
        'staged': file.staged,
        'untracked': file.untracked,
        'additions': file.additions,
        'deletions': file.deletions,
      },
  ],
  'bases': designGitChanges.bases,
};

Map<String, Object?> _githubPr(String rid) => {
  'type': 'github.pr.result',
  'rid': rid,
  'pr': {
    'number': 412,
    'title': designPr.pr.title,
    'url': 'https://github.com/example/iris/pull/39',
    'state': 'OPEN',
    'isDraft': false,
    'head': 'mobile-v6',
    'base': 'main',
    'author': 'demo',
    'body': '',
    'comments': <Object>[],
    'reviews': <Object>[],
    'reviewComments': [
      {
        'author': 'reviewer',
        'body': '좌표 변환에서 데스크톱 프레임 크기도 확인해 주세요.',
        'createdAt': '2026-09-28T00:00:00Z',
        'path': designGitFile.path,
        'line': 214,
        'url': 'https://github.com/example/iris/pull/39#discussion_r1',
      },
    ],
    'files': <Object>[],
    'checks': [
      {
        'name': 'mobile test',
        'conclusion': 'failure',
        'status': 'completed',
        'detailsUrl': 'https://github.com/example/iris/actions/runs/123',
        'runId': '123',
      },
      {
        'name': 'analyze',
        'conclusion': 'success',
        'status': 'completed',
        'detailsUrl': 'https://github.com/example/iris/actions/runs/124',
        'runId': '124',
      },
    ],
    'reviewCommentsLimited': false,
    'reviewCommentsError': '',
  },
};

String _designFrame(String kind) {
  final name = switch (kind) {
    'direct' => 'browser-direct.jpg',
    'desktop' => 'browser-desktop.jpg',
    'preview' => 'human-preview.jpg',
    _ => 'browser-page.jpg',
  };
  return base64Encode(File('test/design_ref/frames/$name').readAsBytesSync());
}
