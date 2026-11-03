import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/screens/review_answers.dart';

void main() {
  test('제출 확인 목록을 질문·답 쌍으로 나눈다', () {
    final answers = parseReviewAnswers(
      "1. 탭을 옮길까요, 복제할까요?\n   → 이동 (Recommended)\n2. 어느 칸에 열까요?\n   → 같은 종류 칸",
    );
    expect(answers.length, 2);
    expect(answers[0].question, '탭을 옮길까요, 복제할까요?');
    expect(answers[0].answer, '이동 (Recommended)');
    expect(answers[1].answer, '같은 종류 칸');
  });

  test('형식이 다르면 빈 목록', () {
    expect(parseReviewAnswers('그냥 문장'), isEmpty);
  });

  test('미응답 경고는 쌍에 섞이지 않고 한글로 표시', () {
    const detail = '1. 질문입니까?\n   → 답\n⚠ You have not answered all questions';
    expect(parseReviewAnswers(detail).single.answer, '답');
    expect(reviewWarning(detail), '답하지 않은 질문이 있습니다.');
    expect(reviewWarning('1. 질문\n   → 답'), isNull);
  });
}
