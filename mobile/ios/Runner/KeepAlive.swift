import Flutter
import UIKit
import UserNotifications

// 채널 iris.remote/keepalive. 안드로이드 포그라운드 서비스의 iOS 대응
// 한계: iOS 에는 포그라운드 서비스가 없어 백그라운드 연결 유지 불가
//  - 앱이 백그라운드로 가면 beginBackgroundTask 유예(보통 수십 초)만 확보, 만료 뒤 앱 정지
//  - 정지 중에는 요청 수 갱신·끊김 알림 없음. 항상 켜 두는 알림은 APNs 서버 중계가 필요(범위 밖)
//  - 상시 "Iris에 연결됨" 알림 없음(iOS 는 고정 알림 불가)
final class KeepAlive: NSObject, UNUserNotificationCenterDelegate {
    static let shared = KeepAlive()

    private static let requestNotificationId = "iris.remote.requests"
    private static let requestCategoryId = "iris.remote.requests.category"

    private var channel: FlutterMethodChannel?
    private var started = false
    private var startRequestInFlight = false
    private var requestCount = 0
    private var alertPending = false
    private var disconnectedPending = false
    private var responsesReady = false
    private var openPending = false
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var observing = false

    private var center: UNUserNotificationCenter { UNUserNotificationCenter.current() }

    // 알림 탭이 콜드 스타트로 들어와도 받도록 앱 시작 때 호출
    func attachDelegate() {
        center.delegate = self
        // 미리보기를 끈 잠금 화면에는 개수·내용 없이 일반 문구만 표시
        let category = UNNotificationCategory(
            identifier: Self.requestCategoryId,
            actions: [],
            intentIdentifiers: [],
            hiddenPreviewsBodyPlaceholder: "응답 요청",
            options: []
        )
        center.setNotificationCategories([category])
    }

    func register(messenger: FlutterBinaryMessenger) {
        let channel = FlutterMethodChannel(name: "iris.remote/keepalive", binaryMessenger: messenger)
        self.channel = channel
        channel.setMethodCallHandler { [weak self] call, result in
            // 상태 접근은 메인 큐에서만(알림 delegate 와 같은 큐)
            self?.onMain {
                guard let self else { return }
                switch call.method {
                case "takeOpenResponses":
                    self.responsesReady = true
                    result(self.takeOpen())
                case "start": self.start(result)
                case "update": self.update(call, result)
                case "stop": self.stop(call, result)
                default: result(FlutterMethodNotImplemented)
                }
            }
        }
    }

    private func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
    }

    private func takeOpen() -> Bool {
        let open = openPending
        openPending = false
        return open
    }

    private var inBackground: Bool {
        UIApplication.shared.applicationState == .background
    }

    // MARK: 채널 메서드

    // 안드로이드 KeepAliveChannel.start 와 같은 오류 코드: notification-denied, permission-pending, start-failed
    private func start(_ result: @escaping FlutterResult) {
        center.getNotificationSettings { [weak self] settings in
            self?.onMain {
                guard let self else { return }
                switch StartPolicy.decide(status: settings.authorizationStatus,
                                          requestInFlight: self.startRequestInFlight) {
                case .succeed: self.finishStart(result)
                case .deny: self.denyStart(result)
                case .pending:
                    result(FlutterError(code: "permission-pending", message: "알림 권한 확인이 진행 중입니다.", details: nil))
                case .ask: self.requestStart(result)
                }
            }
        }
    }

    private func requestStart(_ result: @escaping FlutterResult) {
        startRequestInFlight = true
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, error in
            self?.onMain {
                guard let self else { return }
                self.startRequestInFlight = false
                if let error {
                    result(FlutterError(code: "start-failed", message: error.localizedDescription, details: nil))
                } else if granted {
                    self.finishStart(result)
                } else {
                    self.denyStart(result)
                }
            }
        }
    }

    private func finishStart(_ result: FlutterResult) {
        started = true
        observeLifecycle()
        result(nil)
    }

    private func denyStart(_ result: FlutterResult) {
        result(FlutterError(code: "notification-denied", message: "알림 권한이 필요합니다.", details: nil))
    }

    private func update(_ call: FlutterMethodCall, _ result: FlutterResult) {
        let args = call.arguments as? [String: Any]
        guard let count = args?["requestCount"] as? Int, count >= 0 else {
            result(FlutterError(code: "invalid-arguments", message: "요청 수가 올바르지 않습니다.", details: nil))
            return
        }
        result(nil)
        guard started else { return }
        requestCount = count
        alertPending = (args?["alert"] as? Bool) ?? false
        disconnectedPending = false
        if count <= 0 {
            clearNotification()
        } else if inBackground {
            postRequestNotification()
        }
        // 포그라운드: 앱 안 화면이 대신하므로 알림 없음. 백그라운드 진입 때 마지막 값으로 표시
    }

    private func stop(_ call: FlutterMethodCall, _ result: FlutterResult) {
        let disconnected = ((call.arguments as? [String: Any])?["disconnected"] as? Bool) ?? false
        result(nil)
        started = false
        requestCount = 0
        alertPending = false
        clearNotification()
        if disconnected && inBackground {
            post(title: "연결이 끊겼습니다", sound: true)
        }
        endBackgroundTask()
    }

    // MARK: 알림

    private func postRequestNotification() {
        post(title: "응답 요청 \(requestCount)건", sound: alertPending)
        alertPending = false
    }

    // 같은 identifier 로 갱신, 소리는 alert 일 때만
    private func post(title: String, sound: Bool) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.categoryIdentifier = Self.requestCategoryId
        if sound { content.sound = .default }
        center.add(UNNotificationRequest(identifier: Self.requestNotificationId, content: content, trigger: nil))
    }

    private func clearNotification() {
        center.removePendingNotificationRequests(withIdentifiers: [Self.requestNotificationId])
        center.removeDeliveredNotifications(withIdentifiers: [Self.requestNotificationId])
    }

    // MARK: 앱 상태

    private func observeLifecycle() {
        if observing { return }
        observing = true
        let names = NotificationCenter.default
        names.addObserver(self, selector: #selector(didEnterBackground),
                          name: UIApplication.didEnterBackgroundNotification, object: nil)
        names.addObserver(self, selector: #selector(willEnterForeground),
                          name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    @objc private func didEnterBackground() {
        guard started else { return }
        // 짧은 유예만 확보. 만료되면 시스템이 앱을 정지시킴
        if backgroundTask == .invalid {
            backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "iris.remote.keepalive") { [weak self] in
                self?.endBackgroundTask()
            }
        }
        if requestCount > 0 { postRequestNotification() }
    }

    @objc private func willEnterForeground() {
        endBackgroundTask()
        // 앱 안 화면이 요청을 보여 주므로 표시 중인 알림 제거
        clearNotification()
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    // MARK: UNUserNotificationCenterDelegate

    // 포그라운드에서는 배너·소리 없음
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([])
    }

    // 알림 탭 = 응답 화면 열기. 채널 준비 전이면 takeOpenResponses 가 가져감
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        // delegate 스레드가 불명확하므로 상태 변경·invokeMethod 모두 메인 큐
        let isRequest = response.notification.request.identifier == Self.requestNotificationId
        onMain {
            if isRequest {
                self.openPending = true
                if self.responsesReady, self.takeOpen() {
                    self.channel?.invokeMethod("openResponses", arguments: nil)
                }
            }
            completionHandler()
        }
    }
}
