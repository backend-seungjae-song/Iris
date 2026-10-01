import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/tailscale_store.dart';

void main() {
  const pin =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const secret = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';

  test('Tailscale 설치 QR만 스토어 열기 대상으로 판정한다', () {
    expect(
      TailscaleStore.isInstallQr(
        'https://play.google.com/store/apps/details?id=com.tailscale.ipn',
      ),
      isTrue,
    );
    expect(
      TailscaleStore.isInstallQr('https://example.com/?id=other'),
      isFalse,
    );
    expect(TailscaleStore.isInstallQr('{"t":"iris-remote-pair"}'), isFalse);
  });

  group('JCS', () {
    test('서버 연결 벡터와 같은 바이트를 만든다', () async {
      final file = File('../server/remote/contract/connection-vectors.json');
      final vector =
          jsonDecode(await file.readAsString()) as Map<String, dynamic>;
      final target = vector['target'] as Map<String, dynamic>;
      final expected =
          vector['canonical'] as String? ?? _fallbackCanonical(target);

      expect(canonicalJson(target), expected);
      expect(utf8.decode(canonicalJsonBytes(target)), expected);
    });

    test('키를 UTF-16 코드 단위 순서로 정렬한다', () {
      expect(canonicalJson({'\u{10000}': 1, '\ue000': 2}), '{"𐀀":1,"":2}');
    });

    test('짝이 없는 surrogate와 유한하지 않은 수를 거부한다', () {
      expect(() => canonicalJson('\ud800'), throwsA(isA<ProtocolException>()));
      expect(
        () => canonicalJson(double.infinity),
        throwsA(isA<ProtocolException>()),
      );
    });

    test('ECMAScript 숫자 표기를 사용한다', () {
      expect(canonicalJson(1.0), '1');
      expect(canonicalJson(-0.0), '0');
      expect(canonicalJson(1e21), '1e+21');
      expect(
        () => canonicalJson(9007199254740992),
        throwsA(isA<ProtocolException>()),
      );
    });
  });

  group('페어링 QR', () {
    test('Tailscale 설치 QR은 연결 QR로 받지 않는다', () {
      expect(
        () => PairingQr.parse(
          'https://play.google.com/store/apps/details?id=com.tailscale.ipn',
        ),
        throwsA(
          isA<ProtocolException>().having(
            (error) => error.message,
            'message',
            contains('Tailscale 설치 QR'),
          ),
        ),
      );
    });

    test('정확한 계약을 읽는다', () {
      final qr = PairingQr.parse(
        jsonEncode({
          't': 'iris-remote-pair',
          'v': 1,
          'address': '100.64.1.2',
          'port': 4293,
          'certHash': pin,
          'secret': secret,
        }),
      );

      expect(qr.address, '100.64.1.2');
      expect(qr.port, 4293);
      expect(qr.certHash, pin);
      expect(qr.secret, secret);
    });

    test('추가 키를 거부한다', () {
      expect(
        () => PairingQr.parse(
          jsonEncode({
            't': 'iris-remote-pair',
            'v': 1,
            'address': '100.64.1.2',
            'port': 4293,
            'certHash': pin,
            'secret': secret,
            'extra': true,
          }),
        ),
        throwsA(isA<ProtocolException>()),
      );
    });

    for (final invalid in [
      {'address': '100.064.1.2'},
      {'address': '256.64.1.2'},
      {'port': 0},
      {'port': 65536},
      {'certHash': '${pin.substring(1)}g'},
      {'secret': '${secret}x'},
    ]) {
      test('$invalid 값을 거부한다', () {
        final value = <String, Object>{
          't': 'iris-remote-pair',
          'v': 1,
          'address': '100.64.1.2',
          'port': 4293,
          'certHash': pin,
          'secret': secret,
          ...invalid,
        };
        expect(
          () => PairingQr.parse(jsonEncode(value)),
          throwsA(isA<ProtocolException>()),
        );
      });
    }
  });

  group('챌린지', () {
    final challenge = <String, Object>{
      'type': 'auth.challenge',
      'v': remoteProtocolVersion,
      'serverInstance': '1' * 32,
      'connId': '2' * 32,
      'nonce': '3' * 64,
      'certHash': pin,
    };

    test('정확한 계약과 pin을 받는다', () {
      final parsed = AuthChallenge.parse(challenge, pin: pin);
      expect(parsed.connId, '2' * 32);
      expect(parsed.signingTarget('4' * 32), {
        'domain': 'iris-remote-conn/1',
        'v': 1,
        'serverInstance': '1' * 32,
        'connId': '2' * 32,
        'deviceId': '4' * 32,
        'nonce': '3' * 64,
        'certHash': pin,
      });
    });

    test('다른 pin을 거부한다', () {
      expect(
        () => AuthChallenge.parse(challenge, pin: 'b' * 64),
        throwsA(
          isA<ProtocolException>().having(
            (error) => error.message,
            'message',
            contains('인증서'),
          ),
        ),
      );
    });

    test('빠진 키, 추가 키, 잘못된 길이를 거부한다', () {
      final missing = Map<String, Object>.from(challenge)..remove('nonce');
      final extra = Map<String, Object>.from(challenge)..['extra'] = true;
      final malformed = Map<String, Object>.from(challenge)
        ..['connId'] = '2' * 31;
      for (final value in [missing, extra, malformed]) {
        expect(
          () => AuthChallenge.parse(value, pin: pin),
          throwsA(isA<ProtocolException>()),
        );
      }
    });
  });

  group('메시지', () {
    test('pair.request의 키와 값을 정확히 만든다', () {
      const publicKey = 'AQID';
      expect(
        pairRequest(secret: secret, publicKey: publicKey, name: 'Galaxy S'),
        {
          'type': 'pair.request',
          'v': remoteProtocolVersion,
          'secret': secret,
          'connKey': publicKey,
          'name': 'Galaxy S',
        },
      );
    });

    test('auth.response와 PIN과 caps.get의 키를 정확히 만든다', () {
      expect(authResponse(deviceId: '4' * 32, signature: 'AQID'), {
        'type': 'auth.response',
        'v': remoteProtocolVersion,
        'deviceId': '4' * 32,
        'signature': 'AQID',
      });
      expect(
        authResponse(
          deviceId: '4' * 32,
          signature: 'AQID',
          resumeToken: 'a' * 43,
        ),
        {
          'type': 'auth.response',
          'v': remoteProtocolVersion,
          'deviceId': '4' * 32,
          'signature': 'AQID',
          'resumeToken': 'a' * 43,
        },
      );
      expect(pinSubmit('123456'), {
        'type': 'pin.submit',
        'v': remoteProtocolVersion,
        'pin': '123456',
      });
      expect(() => pinSubmit('12345'), throwsA(isA<ProtocolException>()));
      expect(capsGet(), {'type': 'caps.get'});
    });

    test('서버 인증·PIN·권한 메시지를 읽는다', () {
      expect(
        parseServerMessage(
          jsonEncode({
            'type': 'pair.pending',
            'v': remoteProtocolVersion,
            'deviceId': '4' * 32,
            'code': '123456',
          }),
        ),
        isA<PairPending>(),
      );
      expect(
        parseServerMessage(
          jsonEncode({
            'type': 'auth.ok',
            'v': remoteProtocolVersion,
            'resumeToken': 'a' * 43,
            'pinIdleMinutes': 30,
          }),
        ),
        isA<AuthOk>(),
      );
      expect(
        parseServerMessage(
          jsonEncode({'type': 'pin.required', 'v': remoteProtocolVersion}),
        ),
        isA<PinRequired>(),
      );
      final pinError = parseServerMessage(
        jsonEncode({
          'type': 'pin.error',
          'v': remoteProtocolVersion,
          'reason': 'retry-later',
          'retryAfterMs': 2000,
        }),
      ) as PinError;
      expect(pinError.reason, 'retry-later');
      expect(pinError.retryAfterMs, 2000);
      final serviceStatus = parseServerMessage(
        jsonEncode({
          'type': 'service.status',
          'v': remoteProtocolVersion,
          'reason': 'sharing-disabled',
        }),
      ) as ServiceStatus;
      expect(serviceStatus.reason, 'sharing-disabled');
      final caps = parseServerMessage(
        jsonEncode({
          'type': 'caps',
          'remoteRpc': remoteProtocolVersion,
          'macName': 'MacBook Pro',
          'requests': ['caps.get'],
        }),
      ) as Capabilities;
      expect(caps.macName, 'MacBook Pro');
      expect(caps.requests, ['caps.get']);
      expect(
        parseServerMessage(
          jsonEncode({
            'type': 'error',
            'error': {'code': 'forbidden'},
          }),
        ),
        isA<RemoteError>(),
      );
    });

    test('서버 메시지의 추가 키와 중복 권한을 거부한다', () {
      expect(
        () => parseServerMessage(
          jsonEncode({
            'type': 'auth.ok',
            'v': remoteProtocolVersion,
            'extra': true,
          }),
        ),
        throwsA(isA<ProtocolException>()),
      );
      expect(
        () => parseServerMessage(
          jsonEncode({
            'type': 'caps',
            'remoteRpc': remoteProtocolVersion,
            'macName': 'MacBook Pro',
            'requests': ['caps.get', 'caps.get'],
          }),
        ),
        throwsA(isA<ProtocolException>()),
      );
    });
  });

  group('원격 조작 계약', () {
    final agent = 'a' * 32;
    final request = 'b' * 32;

    test('요청별 키를 정확히 만든다', () {
      expect(pingRequest('r1'), {'type': 'ping', 'rid': 'r1', 'active': false});
      expect(pingRequest('r1', active: true), {
        'type': 'ping',
        'rid': 'r1',
        'active': true,
      });
      expect(watchRequest('r2'), {'type': 'watch', 'rid': 'r2'});
      expect(transcriptPageRequest(rid: 'r3', agent: agent, before: 'cursor'), {
        'type': 'transcript.page',
        'rid': 'r3',
        'agent': agent,
        'before': 'cursor',
      });
      expect(transcriptWatchRequest(rid: 'r4', agent: agent), {
        'type': 'transcript.watch',
        'rid': 'r4',
        'agent': agent,
      });
      expect(agentStopRequest(rid: 'r5', agent: agent), {
        'type': 'agent.stop',
        'rid': 'r5',
        'agent': agent,
      });
      expect(agentMessageRequest(rid: 'r6', agent: agent, text: '첫 줄\n둘째 줄'), {
        'type': 'agent.message',
        'rid': 'r6',
        'agent': agent,
        'text': '첫 줄\n둘째 줄',
      });
      expect(
        agentMessageRequest(rid: 'r6b', agent: agent, text: '첫 줄\r\n둘째 줄'),
        containsPair('text', '첫 줄\r\n둘째 줄'),
      );
      expect(
        agentMessageRequest(
          rid: 'r6c',
          agent: agent,
          text: '',
          drafts: ['d' * 32, 'e' * 32],
        ),
        containsPair('drafts', ['d' * 32, 'e' * 32]),
      );
      expect(
        permissionAnswerRequest(rid: 'r7', request: request, allow: false),
        {
          'type': 'request.answer',
          'rid': 'r7',
          'request': request,
          'answer': {'behavior': 'deny'},
        },
      );
    });

    test('에이전트·요청·대화 응답을 읽는다', () {
      final agents = parseServerMessage(
        jsonEncode({
          'type': 'agents',
          'agents': [
            {
              'ref': agent,
              'name': '문서 정리',
              'kind': 'claude',
              'status': 'working',
              'question': false,
              'space': 'iris',
              'spaceRef': 'c' * 32,
              'spaceOrder': 1,
              'sessionOrder': 2,
              'parent': null,
              'lastActivityAt': 1000,
              'can': {'stop': true, 'message': true},
            },
          ],
        }),
      ) as AgentsMessage;
      expect(agents.agents.single.name, '문서 정리');
      expect(agents.agents.single.spaceOrder, 1);
      expect(agents.agents.single.sessionOrder, 2);
      expect(agents.agents.single.parent, isNull);

      final requests = parseServerMessage(
        jsonEncode({
          'type': 'requests',
          'requests': [
            {
              'ref': request,
              'agent': agent,
              'kind': 'claude-permission',
              'createdAt': 1000,
              'expiresAt': 2000,
              'body': {
                'tool': 'Bash',
                'description': '검사를 실행합니다.',
                'input': 'flutter test',
              },
            },
          ],
        }),
      ) as RequestsMessage;
      expect(requests.requests.single.body, isA<PermissionRequestBody>());

      final questions = parseServerMessage(
        jsonEncode({
          'type': 'requests',
          'requests': [
            {
              'ref': request,
              'agent': agent,
              'kind': 'claude-question',
              'createdAt': 1000,
              'expiresAt': 2000,
              'body': {
                'questions': [
                  {
                    'question': '어느 쪽인가요?',
                    'header': '선택',
                    'multiSelect': false,
                    'options': [
                      {'label': 'A', 'description': '첫 번째'},
                    ],
                  },
                ],
              },
            },
          ],
        }),
      ) as RequestsMessage;
      expect(questions.requests.single.body, isA<QuestionRequestBody>());

      final transcript = parseServerMessage(
        jsonEncode({
          'type': 'transcript',
          'rid': 'r8',
          'agent': agent,
          'items': [
            {'role': 'assistant', 'text': '완료했습니다.', 'at': 1000},
          ],
          'before': null,
        }),
      ) as TranscriptPage;
      expect(transcript.items.single.text, '완료했습니다.');
    });

    test('추가 키와 잘못된 결과를 거부한다', () {
      for (final value in [
        {'type': 'agents', 'agents': <Object>[], 'extra': true},
        {
          'type': 'agents',
          'agents': [
            {
              'ref': agent,
              'name': '문서 정리',
              'kind': 'claude',
              'status': 'working',
              'question': false,
              'space': 'iris',
              'spaceRef': 'c' * 32,
              'spaceOrder': 0,
              'sessionOrder': 0,
              'parent': null,
              'lastActivityAt': null,
              'can': {'stop': true, 'message': true},
              'paneId': 'secret',
            },
          ],
        },
        {'type': 'agent.stop.result', 'rid': 'r1', 'result': 'stopped'},
        {'type': 'pong', 'rid': '공백'},
      ]) {
        expect(
          () => parseServerMessage(jsonEncode(value)),
          throwsA(isA<ProtocolException>()),
        );
      }
      expect(
        () => agentMessageRequest(rid: 'r1', agent: agent, text: '탭\t포함'),
        throwsA(isA<ProtocolException>()),
      );
      expect(
        () => transcriptPageRequest(rid: 'r1', agent: agent, before: 'x' * 129),
        throwsA(isA<ProtocolException>()),
      );
    });

    test('단일·다중·직접 입력 질문 답을 만든다', () {
      const body = QuestionRequestBody([
        RequestQuestion(
          question: '하나를 고르세요',
          header: '단일',
          multiSelect: false,
          options: [
            RequestOption(label: 'A', description: ''),
            RequestOption(label: 'B', description: ''),
          ],
        ),
        RequestQuestion(
          question: '여러 개를 고르세요',
          header: '다중',
          multiSelect: true,
          options: [
            RequestOption(label: 'C', description: ''),
            RequestOption(label: 'D', description: ''),
          ],
        ),
      ]);
      expect(
        questionAnswerRequest(
          rid: 'r9',
          request: request,
          body: body,
          responses: const [
            QuestionText('직접 답'),
            QuestionLabels(['C', 'D']),
          ],
        ),
        {
          'type': 'request.answer',
          'rid': 'r9',
          'request': request,
          'answer': {
            'answers': [
              {'text': '직접 답'},
              {
                'labels': ['C', 'D'],
              },
            ],
          },
        },
      );
    });

    test('질문 답 개수·선택 수·직접 입력 길이를 거부한다', () {
      const single = QuestionRequestBody([
        RequestQuestion(
          question: '선택',
          header: '단일',
          multiSelect: false,
          options: [RequestOption(label: 'A', description: '')],
        ),
      ]);
      for (final responses in <List<QuestionResponse>>[
        const [],
        const [QuestionLabels([])],
        const [
          QuestionLabels(['A', 'A']),
        ],
        [QuestionText('x' * 2001)],
      ]) {
        expect(
          () => questionAnswerRequest(
            rid: 'r10',
            request: request,
            body: single,
            responses: responses,
          ),
          throwsA(isA<ProtocolException>()),
        );
      }
    });
  });

  group('고급 원격 조작 계약', () {
    final agent = 'a' * 32;
    final tab = 'b' * 32;
    final space = 'c' * 32;
    final file = 'd' * 32;

    test('터미널·브라우저·Git 요청 키를 정확히 만든다', () {
      expect(terminalWatchRequest(rid: 'r1', agent: agent), {
        'type': 'terminal.watch',
        'rid': 'r1',
        'agent': agent,
      });
      expect(
        browserFrameWatchRequest(
          rid: 'r2',
          tab: tab,
          width: 394,
          fps: 2,
          desktop: false,
        ),
        {
          'type': 'browser.frame.watch',
          'rid': 'r2',
          'tab': tab,
          'width': 394,
          'fps': 2,
          'desktop': false,
        },
      );
      expect(
        browserPointerRequest(
          rid: 'r3',
          tab: tab,
          x: 197,
          y: 324,
          width: 394,
          height: 648,
        ),
        containsPair('action', 'click'),
      );
      expect(
        browserMouseRequest(
          rid: 'r3m',
          tab: tab,
          x: 197,
          y: 324,
          width: 394,
          height: 648,
          action: 'wheel',
          dy: 240,
        ),
        {
          'type': 'browser.mouse',
          'rid': 'r3m',
          'tab': tab,
          'x': 197.0,
          'y': 324.0,
          'width': 394,
          'height': 648,
          'action': 'wheel',
          'dy': 240,
        },
      );
      expect(
        browserElementHoverRequest(
          rid: 'r3h',
          tab: tab,
          x: 197,
          y: 324,
          width: 394,
          height: 648,
        ),
        containsPair('type', 'browser.element.hover'),
      );
      expect(
        browserElementPickRequest(
          rid: 'r3p',
          tab: tab,
          agent: agent,
          x: 197,
          y: 324,
          width: 394,
          height: 648,
        ),
        containsPair('type', 'browser.element.pick'),
      );
      expect(browserFocusRequest(rid: 'r3f', tab: tab), {
        'type': 'browser.focus',
        'rid': 'r3f',
        'tab': tab,
      });
      expect(
        browserDialogRequest(
          rid: 'r3d',
          tab: tab,
          action: 'accept',
          text: '확인',
        ),
        containsPair('text', '확인'),
      );
      expect(
        () => browserMouseRequest(
          rid: 'bad',
          tab: tab,
          x: 1,
          y: 1,
          width: 394,
          height: 648,
          action: 'move',
          dy: 1,
        ),
        throwsA(isA<ProtocolException>()),
      );
      expect(
        gitDiffDraftRequest(
          rid: 'r4',
          agent: agent,
          file: file,
          side: 'new',
          line: 42,
          text: '이 줄을 확인해 주세요.',
        ),
        containsPair('type', 'git.diff.draft'),
      );
      expect(
        browserNewTabRequest(rid: 'r5', space: space),
        isNot(contains('url')),
      );
    });

    test('터미널·브라우저 푸시와 사람 차례를 읽는다', () {
      final terminal = parseServerMessage(
        jsonEncode({
          'type': 'terminal.frame',
          'agent': agent,
          'revision': 2,
          'text': '\x1b[31m✗ flutter test\x1b[0m',
          'truncated': false,
        }),
      ) as TerminalFrame;
      expect(terminal.revision, 2);
      expect(terminal.text, contains('\x1b[31m'));

      final frame = parseServerMessage(
        jsonEncode({
          'type': 'browser.frame',
          'tab': tab,
          'seq': 1,
          'width': 394,
          'height': 648,
          'jpeg': 'AQID',
        }),
      ) as BrowserFrame;
      expect(frame.jpeg, [1, 2, 3]);

      final largeJpeg = Uint8List(384 * 1024);
      final largeFrame = parseServerMessage(
        jsonEncode({
          'type': 'browser.frame',
          'tab': tab,
          'seq': 2,
          'width': 1080,
          'height': 1776,
          'jpeg': base64Encode(largeJpeg),
        }),
      ) as BrowserFrame;
      expect(largeFrame.jpeg.length, 384 * 1024);

      final draft = parseServerMessage(
        jsonEncode({
          'type': 'browser.draft.result',
          'rid': 'draft',
          'ref': 'f' * 32,
          'kind': 'record',
          'summary': '5단계',
          'content': '[폰 브라우저 조작 기록]\n1. 클릭',
        }),
      ) as BrowserDraftResult;
      expect(draft.summary, '5단계');

      final hover = parseServerMessage(
        jsonEncode({
          'type': 'browser.element.hover.result',
          'rid': 'hover',
          'viewport': {'width': 800, 'height': 600},
          'element': {
            'selector': '#save',
            'text': '저장',
            'rect': {'x': 10, 'y': 20, 'width': 100, 'height': 40},
          },
        }),
      ) as BrowserElementHoverResult;
      expect(hover.viewport.width, 800);
      expect(hover.element!.selector, '#save');

      final focus = parseServerMessage(
        jsonEncode({
          'type': 'browser.focus.result',
          'rid': 'focus',
          'editable': true,
          'kind': 'text',
          'multiline': false,
          'selectedText': '선택',
        }),
      ) as BrowserFocusResult;
      expect(focus.editable, true);
      expect(focus.selectedText, '선택');

      final dialog = parseServerMessage(
        jsonEncode({
          'type': 'browser.dialog.result',
          'rid': 'dialog',
          'dialog': {'kind': 'prompt', 'message': '이름'},
        }),
      ) as BrowserDialogResult;
      expect(dialog.dialog!.kind, 'prompt');

      final requests = parseServerMessage(
        jsonEncode({
          'type': 'requests',
          'requests': [
            {
              'ref': 'e' * 32,
              'agent': agent,
              'kind': 'browser-user',
              'createdAt': 1000,
              'expiresAt': 2000,
              'body': {
                'title': '카드 인증',
                'text': '직접 진행해 주세요.',
                'choices': ['다 했음', '못 하겠음'],
                'tab': tab,
              },
            },
          ],
        }),
      ) as RequestsMessage;
      final body = requests.requests.single.body as BrowserUserRequestBody;
      expect(body.title, '카드 인증');
      expect(body.tab, tab);
    });

    test('기록 경과 시간과 Git 증감 계약을 정확히 읽는다', () {
      final record = parseServerMessage(
        jsonEncode({
          'type': 'browser.record.result',
          'rid': 'r1',
          'state': 'paused',
          'steps': ['결제 버튼 누름 · button.pay'],
          'elapsedMs': 24000,
        }),
      ) as BrowserRecordResult;
      expect(record.elapsedMs, 24000);

      final changes = parseServerMessage(
        jsonEncode({
          'type': 'git.changes.result',
          'rid': 'r2',
          'branch': 'feat/worktree-row',
          'ahead': 3,
          'behind': 0,
          'base': 'main',
          'commitCount': 3,
          'additions': 84,
          'deletions': 31,
          'files': [
            {
              'ref': 'f' * 32,
              'path': 'web/js/worktrees/worktree-row.js',
              'code': 'M',
              'staged': false,
              'untracked': false,
              'additions': 12,
              'deletions': 5,
            },
          ],
          'bases': ['main'],
        }),
      ) as GitChangesResult;
      expect(changes.base, 'main');
      expect(changes.files.single.additions, 12);

      final withExtra = {
        'type': 'browser.record.result',
        'rid': 'r1',
        'state': 'paused',
        'steps': <String>[],
        'elapsedMs': 1,
        'startedAt': 1,
      };
      expect(
        () => parseServerMessage(jsonEncode(withExtra)),
        throwsA(isA<ProtocolException>()),
      );
    });

    test('위험한 URL·범위 밖 좌표·큰 스케치를 거부한다', () {
      expect(
        () => browserNavigateRequest(
          rid: 'r1',
          tab: tab,
          url: 'file:///private/secret',
        ),
        throwsA(isA<ProtocolException>()),
      );
      expect(
        () => browserPointerRequest(
          rid: 'r2',
          tab: tab,
          x: 395,
          y: 1,
          width: 394,
          height: 648,
        ),
        throwsA(isA<ProtocolException>()),
      );
      expect(
        () => browserSketchSendRequest(
          rid: 'r3',
          agent: agent,
          tab: tab,
          image: 'data:image/png;base64,${'A' * (49 * 1024)}',
          text: '강조',
        ),
        throwsA(isA<ProtocolException>()),
      );
    });

    test('기기 물리 폭과 확대 배율로 브라우저 요청 폭을 계산한다', () {
      expect(
        browserFrameRequestWidth(
          logicalWidth: 394,
          devicePixelRatio: 1080 / 394,
          zoom: 1,
          desktop: false,
        ),
        1080,
      );
      expect(
        browserFrameRequestWidth(
          logicalWidth: 394,
          devicePixelRatio: 1080 / 394,
          zoom: 4,
          desktop: false,
        ),
        2560,
      );
      expect(
        browserFrameRequestWidth(
          logicalWidth: 394,
          devicePixelRatio: 1,
          zoom: 1,
          desktop: true,
        ),
        1280,
      );
    });

    test('GitHub PR 응답의 전체 필드 한도를 검사한다', () {
      final valid = _githubPrMessage();
      expect(parseServerMessage(jsonEncode(valid)), isA<GitHubPrResult>());

      final longTitle = _githubPrMessage();
      (longTitle['pr']! as Map<String, Object?>)['title'] = '가' * 501;
      expect(
        () => parseServerMessage(jsonEncode(longTitle)),
        throwsA(isA<ProtocolException>()),
      );

      final tooManyComments = _githubPrMessage();
      (tooManyComments['pr']!
          as Map<String, Object?>)['comments'] = List.filled(101, {
        'author': '',
        'body': '',
        'createdAt': '',
        'url': '',
      });
      expect(
        () => parseServerMessage(jsonEncode(tooManyComments)),
        throwsA(isA<ProtocolException>()),
      );
    });
  });
}

Map<String, Object?> _githubPrMessage() => {
  'type': 'github.pr.result',
  'rid': 'r1',
  'pr': <String, Object?>{
    'number': 39,
    'title': '모바일 원격 제어',
    'url': 'https://github.com/example/iris/pull/39',
    'state': 'OPEN',
    'isDraft': false,
    'head': 'mobile-v6',
    'base': 'main',
    'author': 'reviewer',
    'body': '',
    'comments': <Object?>[],
    'reviews': <Object?>[],
    'reviewComments': <Object?>[],
    'files': <Object?>[],
    'checks': <Object?>[],
    'reviewCommentsLimited': false,
    'reviewCommentsError': '',
  },
};

String _fallbackCanonical(Map<String, dynamic> target) {
  final keys = target.keys.toList()..sort();
  return '{${keys.map((key) => '${jsonEncode(key)}:${jsonEncode(target[key])}').join(',')}}';
}
