import 'package:flutter/material.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/status_chip.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/format/control_characters.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/screens/permission_request_screen.dart';
import 'package:iris_remote/screens/response_kit.dart';

// 대화 화면의 "답 대기 중" 카드. 일반 승인·질문·사람 차례 요청을 보여주고 전체 응답 화면을 연다
class ConversationRequestCard extends StatelessWidget {
  const ConversationRequestCard({
    required this.request,
    required this.onOpen,
    super.key,
  });

  final RemoteRequest request;
  final VoidCallback onOpen;

  (String, String, bool) _summary() {
    final body = request.body;
    return switch (body) {
      PermissionRequestBody() => (
        permissionKindLabel(body.tool),
        visibleControlCharacters(
          body.input.isEmpty ? body.description : body.input,
        ),
        true,
      ),
      QuestionRequestBody() => (
        body.questions.length > 1 ? '질문 ${body.questions.length}개' : '질문',
        body.questions.isEmpty ? '' : body.questions.first.question,
        false,
      ),
      BrowserUserRequestBody() => (
        '사람 차례',
        body.title.isEmpty ? body.text : body.title,
        false,
      ),
    };
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final (label, text, mono) = _summary();
    return Container(
      key: Key('conversation-request-${request.ref}'),
      decoration: BoxDecoration(
        color: colors.level1,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: colors.pink, width: 1.5),
      ),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const IrisStatusChip(IrisStatus.block, label: '답 필요'),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: colors.foreground2,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Text(
                responseAgo(request.createdAt),
                style: TextStyle(color: colors.muted, fontSize: 12.5),
              ),
            ],
          ),
          if (text.isNotEmpty) ...[
            const SizedBox(height: 10),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(
                color: colors.level2,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(
                text,
                maxLines: 4,
                overflow: TextOverflow.ellipsis,
                style: (mono ? IrisType.mono : IrisType.body).copyWith(
                  color: colors.foreground,
                  fontSize: mono ? 13.5 : 15,
                  height: 1.45,
                ),
              ),
            ),
          ],
          const SizedBox(height: 12),
          IrisButton(
            key: Key('conversation-request-open-${request.ref}'),
            label: '답하기',
            tone: IrisButtonTone.primary,
            expand: false,
            width: double.infinity,
            onPressed: onOpen,
          ),
        ],
      ),
    );
  }
}
