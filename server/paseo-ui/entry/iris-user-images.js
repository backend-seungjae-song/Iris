// 대화 화면에서 보낸 말 행에 기록의 글·이미지를 입힘(useUserImages)
// - 저장소 구독 안에서 부르므로 같은 행에 두 번 적용하면 그대로 돌려줘야 함. 아니면 쓰기가 구독을 다시 불러 무한 반복
// - 기록에 이미지가 없으면(Codex 는 경로를 글로 받음·아직 못 받음) 행의 이미지(보낼 때 붙인 것)를 그대로 둠
export function patchUserRow(it, want) {
  if (it?.kind !== "user_message" || !want) return it;
  const text = want.text ?? it.text;
  const images = want.metas?.length ? want.metas : it.images;
  if ((it.images?.length ?? 0) === (images?.length ?? 0) && text === it.text) return it;
  return { ...it, text, ...(images ? { images } : {}) };
}
