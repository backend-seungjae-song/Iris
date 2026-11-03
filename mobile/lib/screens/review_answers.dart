import 'package:flutter/material.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/format/question_text.dart';

// 제출 확인 화면의 "번호. 질문 / → 답" 목록 한 쌍
class ReviewAnswer {
  const ReviewAnswer(this.question, this.answer);
  final String question;
  final String answer;
}

// 제출 확인 화면의 경고 줄. 답하지 않은 질문이 있을 때만 나옴
String? reviewWarning(String detail) =>
    RegExp(r'not answered all questions', caseSensitive: false).hasMatch(detail)
    ? '답하지 않은 질문이 있습니다.'
    : null;

final _reviewStart = RegExp(r'^\d+\.\s+(.*)$');

// 서버가 보낸 detail 을 질문·답 쌍으로 나눔. 형식이 다르면 빈 목록
List<ReviewAnswer> parseReviewAnswers(String detail) {
  final out = <ReviewAnswer>[];
  String? question;
  var answer = '';
  void flush() {
    if (question != null) out.add(ReviewAnswer(question!, answer));
    question = null;
    answer = '';
  }

  for (final raw in detail.split('\n')) {
    final line = raw.trim();
    if (line.isEmpty || line.startsWith('⚠')) continue;
    final start = _reviewStart.firstMatch(line);
    if (start != null && !raw.startsWith(' ')) {
      flush();
      question = start.group(1);
    } else if (line.startsWith('→') && question != null) {
      answer = line.substring(1).trim();
    } else if (question != null) {
      if (answer.isEmpty) {
        question = '$question $line';
      } else {
        answer = '$answer $line';
      }
    }
  }
  flush();
  return out;
}

class ReviewAnswersList extends StatelessWidget {
  const ReviewAnswersList({required this.answers, super.key});

  final List<ReviewAnswer> answers;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < answers.length; i++)
          Padding(
            padding: EdgeInsets.only(top: i == 0 ? 0 : 14),
            child: _item(colors, i + 1, answers[i]),
          ),
      ],
    );
  }

  Widget _item(IrisColors colors, int number, ReviewAnswer item) {
    final option = formatOption(item.answer);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 24,
          child: Text(
            '$number',
            style: IrisType.meta.copyWith(
              color: colors.muted,
              fontWeight: FontWeight.w600,
              height: 1.55,
            ),
          ),
        ),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                formatQuestion(item.question).title,
                style: TextStyle(
                  color: colors.muted,
                  fontSize: 14,
                  height: 1.5,
                ),
              ),
              const SizedBox(height: 3),
              Text.rich(
                TextSpan(
                  children: [
                    TextSpan(text: option.label),
                    if (option.recommended)
                      TextSpan(
                        text: '  추천',
                        style: TextStyle(
                          color: colors.muted,
                          fontSize: 12,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                  ],
                ),
                style: TextStyle(
                  color: colors.foreground,
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  height: 1.4,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
