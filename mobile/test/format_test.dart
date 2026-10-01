import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/format/control_characters.dart';
import 'package:iris_remote/format/result_text.dart';

void main() {
  test('제어 문자·방향 제어·폭 없는 문자를 보이는 표기로 바꾼다', () {
    expect(
      visibleControlCharacters('a\u0000\n\u007f\u202e\u200b'),
      'a␀␊␡⟦U+202E⟧⟦U+200B⟧',
    );
  });

  test('실제 요청 결과 문구를 구분한다', () {
    expect(requestAnswerResultText('delivered'), '전달함');
    expect(requestAnswerResultText('already-answered'), '이미 답함(Mac 또는 터미널)');
    expect(requestAnswerResultText('expired'), '만료됨');
    expect(requestAnswerResultText('failed'), '실패');
    expect(agentMessageResultText('sent'), '전송함');
    expect(agentStopResultText('sent'), '중지 요청을 보냄');
  });
}
