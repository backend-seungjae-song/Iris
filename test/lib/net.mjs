// 검사에 쓰는 포트는 커널에게 받는다.
//
// 파일마다 포트를 상수로 두면 같은 스위트를 두 번 겹쳐 돌릴 때 두 사본이 같은 포트를
// 잡으려다 한쪽이 실패한다. 이 실패는 결함이 아니라 충돌이라서 진짜 결함과 구분되지
// 않고, 이렇게 흔들리는 검사는 실패해도 신뢰를 잃는다. 실제로 그 흔들림이 자물쇠 이중
// 소유라는 결함을 오래 가렸다.
//
// 여기서 얻은 번호는 "지금 비어 있다"까지만 보장한다. 받은 즉시 쓰는 것을 전제로 한다.
import net from "node:net";

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

