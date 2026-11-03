import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/format/question_text.dart';

void main() {
  approvalLabelTests();
  toolApprovalTests();
  readingLabelTests();
  group('joinWrappedLines', () {
    test('터미널 폭 줄바꿈은 공백 한 칸으로 이음', () {
      expect(
        joinWrappedLines("칸 안 탭 메뉴의 '다른 탭 모두 닫기'는 어디까지\n닫을까요?"),
        "칸 안 탭 메뉴의 '다른 탭 모두 닫기'는 어디까지 닫을까요?",
      );
      expect(
        joinWrappedLines('Which scope should the\nclose action cover?'),
        'Which scope should the close action cover?',
      );
    });

    test('줄 끝이 문장부호·콜론이면 줄바꿈 유지', () {
      expect(joinWrappedLines('범위를 정합니다.\n다음 질문'), '범위를 정합니다.\n다음 질문');
      expect(joinWrappedLines('다음 중 고르세요:\n하나'), '다음 중 고르세요:\n하나');
      expect(joinWrappedLines('"끝났나요?"\n다음'), '"끝났나요?"\n다음');
    });

    test('다음 줄이 목록·들여쓰기면 줄바꿈 유지', () {
      expect(joinWrappedLines('옵션\n- 가\n- 나'), '옵션\n- 가\n- 나');
      expect(joinWrappedLines('옵션\n1. 가\n2) 나'), '옵션\n1. 가\n2) 나');
      expect(joinWrappedLines('옵션\n• 가'), '옵션\n• 가');
      expect(joinWrappedLines('설명\n    코드 줄'), '설명\n코드 줄');
    });

    test('빈 줄은 문단 구분, 전체 들여쓰기는 무시', () {
      expect(joinWrappedLines('  가나\n  다라\n\n  마바'), '가나 다라\n\n마바');
    });
  });

  group('formatQuestion', () {
    test('물음표로 끝나는 문장이 제목, 나머지는 보조 설명', () {
      final q = formatQuestion("칸 안 탭 메뉴의 '다른 탭 모두 닫기'·'모두 닫기'는 어디까지\n닫을까요?");
      expect(q.title, "칸 안 탭 메뉴의 '다른 탭 모두 닫기'·'모두 닫기'는 어디까지 닫을까요?");
      expect(q.body, '');
      final r = formatQuestion('지금 탭을 정리합니다. 어디까지 닫을까요?');
      expect(r.title, '어디까지 닫을까요?');
      expect(r.body, '지금 탭을 정리합니다.');
    });

    test('물음표가 없으면 첫 문장이 제목', () {
      final q = formatQuestion('계속 진행합니다. 되돌릴 수 없습니다.');
      expect(q.title, '계속 진행합니다.');
      expect(q.body, '되돌릴 수 없습니다.');
    });

    test('따옴표·백틱 안의 마침표에서는 나누지 않음', () {
      final q = formatQuestion('`a. b` 를 쓸까요? 설명입니다.');
      expect(q.title, '`a. b` 를 쓸까요?');
      expect(q.body, '설명입니다.');
      expect(
        formatQuestion('v1.2 와 "x. y" 중 무엇으로 할까요?').title,
        'v1.2 와 "x. y" 중 무엇으로 할까요?',
      );
    });

    test('줄바꿈이 남은 목록은 보조 설명에 유지', () {
      final q = formatQuestion('무엇을 할까요?\n- 가\n- 나');
      expect(q.title, '무엇을 할까요?');
      expect(q.body, '- 가\n- 나');
    });

    test('빈 입력', () {
      expect(formatQuestion('  ').title, '');
    });
  });

  group('formatOption', () {
    test('앞의 ❯·번호 제거, 끝의 (Recommended) 와 ✔ 분리', () {
      final o = formatOption('❯ 1. 그 칸만 (Recommended) ✔');
      expect(o.label, '그 칸만');
      expect(o.recommended, isTrue);
      expect(o.previous, isTrue);
    });

    test('표시가 없으면 둘 다 거짓', () {
      final o = formatOption('2. 전부');
      expect(o.label, '전부');
      expect(o.recommended, isFalse);
      expect(o.previous, isFalse);
    });

    test('불릿·체크 표시 제거', () {
      expect(formatOption('- 가').label, '가');
      expect(formatOption('[x] 찾기').label, '찾기');
      expect(formatOption('[ ] 닫은 탭 복구').label, '닫은 탭 복구');
    });

    test('고정 영어 문구는 한글로, 모르는 문구는 원문 유지', () {
      expect(formatOption('3. Type something.').label, '직접 입력');
      expect(formatOption('4. Type your own...').label, '직접 입력');
      expect(formatOption('5. Chat about this').label, '이 내용으로 대화하기');
      expect(formatOption('1. Submit answers').label, '답변 제출');
      expect(formatOption('2. Cancel').label, '취소');
      expect(formatOption('Keep going').label, 'Keep going');
    });

    test('설명은 줄바꿈을 이어 한 문단으로', () {
      expect(
        formatOption('가', description: '첫 줄이고\n둘째 줄\n  셋째').description,
        '첫 줄이고 둘째 줄 셋째',
      );
    });
  });
}

void approvalLabelTests() {
  group('승인 선택지 한글 표시', () {
    test('Claude·Codex 고정 문구와 단축키 안내', () {
      expect(formatOption('› 1. Yes, proceed (y)').label, '예, 진행');
      expect(
        formatOption('3. No, and tell Codex what to do differently (esc)')
            .label,
        '아니요, 다르게 할 일 알리기',
      );
      expect(
        formatOption('2. Yes, and don\'t ask again for these files (a)').label,
        '예, 이 파일은 다시 묻지 않기',
      );
      expect(
        formatOption(
          '2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)',
        ).label,
        '예, 편집 자동 수락으로 전환',
      );
      expect(
        formatOption(
          '4. None of the above',
          description: 'Optionally, add details in notes (tab)',
        ).description,
        '필요하면 메모를 추가할 수 있습니다.',
      );
      expect(
        formatOption(
          '2. Yes, clear context and implement',
          description: 'Start a fresh thread (current context: 9% used)',
        ).description,
        '새 대화로 시작합니다. (컨텍스트 9% 사용 중)',
      );
    });
    test('목록에 없는 문구는 원문 유지', () {
      expect(formatOption('1. 간단한 메모장').label, '간단한 메모장');
    });
  });
}

void readingLabelTests() {
  test('Claude 읽기 허용 선택지 한글 표시', () {
    expect(
      formatOption('2. Yes, allow reading from /a/b from this project').label,
      '예, 이 프로젝트에서 읽기 허용: /a/b',
    );
  });
}

void toolApprovalTests() {
  group('toolApprovalText', () {
    test('도구 이름과 대상으로 제목을 정한다', () {
      expect(toolApprovalText('Bash', 'ls').title, '다음 명령을 실행할까요?');
      expect(
        toolApprovalText('Edit', '/p/a.dart').title,
        '/p/a.dart 수정을 허용할까요?',
      );
      expect(toolApprovalText('Edit', '').title, '파일 수정을 허용할까요?');
      expect(
        toolApprovalText('Read', '/etc/hosts').title,
        '/etc/hosts 읽기를 허용할까요?',
      );
      expect(toolApprovalText('ExitPlanMode', '').title, '계획이 준비되었습니다. 진행할까요?');
    });
    test('MCP 도구와 모르는 도구도 이름으로 보인다', () {
      expect(
        toolApprovalText('mcp__iris-mcp__browser_click', '').title,
        'iris-mcp의 browser_click 도구를 사용할까요?',
      );
      expect(toolApprovalText('FutureTool', '').title, 'FutureTool 사용을 허용할까요?');
    });
  });
}
