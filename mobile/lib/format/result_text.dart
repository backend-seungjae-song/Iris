String requestAnswerResultText(String result) => switch (result) {
  'delivered' => '전달함',
  'already-answered' => '이미 답함(컴퓨터 또는 터미널)',
  'expired' => '만료됨',
  'failed' => '실패',
  _ => '알 수 없는 결과',
};

String agentMessageResultText(String result) => switch (result) {
  'delivered' => '전달함',
  'sent' => '전송함',
  'failed' => '실패',
  'unsupported' => '지원하지 않음',
  _ => '알 수 없는 결과',
};

String agentStopResultText(String result) => switch (result) {
  'sent' => '중지 요청을 보냄',
  'not-working' => '작업 중이 아님',
  'unsupported' => '지원하지 않음',
  _ => '알 수 없는 결과',
};
