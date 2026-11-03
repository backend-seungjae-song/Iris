import UIKit

// 앱 전환기 미리보기와 화면 녹화·미러링 화면에 앱 내용이 남지 않도록 가림막을 덮음
// 안드로이드 FLAG_SECURE 의 iOS 대응. Debug 빌드는 화면 확인을 위해 생략, Profile·Release 는 동작
//  - Debug 생략은 Runner Debug 설정의 SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG 에 의존
//  - 녹화·미러링 중에는 기기 화면도 가려짐(캡처만 따로 가리는 공개 API 없음)
//  - 스크린샷은 iOS 가 사전 차단 API 를 주지 않아 막을 수 없음(사후 알림 UIApplication.userDidTakeScreenshotNotification 만 있음)
final class PrivacyShield {
    private var shield: UIView?
    private var inactive = false

    init() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(capturedChanged),
            name: UIScreen.capturedDidChangeNotification, object: nil
        )
    }

    func cover(_ scene: UIScene) {
        inactive = true
        refresh(scene as? UIWindowScene)
    }

    func uncover() {
        inactive = false
        refresh(nil)
    }

    @objc private func capturedChanged() {
        refresh(nil)
    }

    private func refresh(_ preferred: UIWindowScene?) {
        #if !DEBUG
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = preferred ?? scenes.first
        let captured = scene?.screen.isCaptured ?? UIScreen.main.isCaptured
        if ShieldPolicy.shouldCover(inactive: inactive, captured: captured) {
            show(scene)
        } else {
            hide()
        }
        #endif
    }

    private func show(_ scene: UIWindowScene?) {
        guard shield == nil, let scene,
              let window = scene.windows.first(where: \.isKeyWindow) ?? scene.windows.first
        else { return }
        let view = UIView(frame: window.bounds)
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.backgroundColor = .systemBackground
        window.addSubview(view)
        shield = view
    }

    private func hide() {
        shield?.removeFromSuperview()
        shield = nil
    }
}
