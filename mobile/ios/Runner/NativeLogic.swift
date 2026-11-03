import Foundation
import Security
import UserNotifications

// 시간·상태에 의존하는 판정의 순수 함수 모음. Flutter·UIKit 비의존이라 swiftc 단독 컴파일 가능

// 잠자기 시간을 포함하고 시스템 시각 변경에 영향받지 않는 단조 시계(나노초)
enum MonotonicClock {
    static func nanos() -> UInt64 { clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) }
}

// unlock 상태 기계. 시각은 호출자가 단조 시계 값으로 전달
struct UnlockTracker {
    static let limitNanos: UInt64 = 300 * 1_000_000_000

    private(set) var generation: UInt64 = 0
    private(set) var inProgress = false
    private(set) var grantedAt: UInt64?

    // 진행 중이면 nil, 아니면 이 인증의 세대 번호
    mutating func begin() -> UInt64? {
        if inProgress { return nil }
        inProgress = true
        return generation
    }

    // 취소된 세대의 결과는 무시(false), 진행 상태도 건드리지 않음
    mutating func finish(generation started: UInt64, success: Bool, now: UInt64) -> Bool {
        guard started == generation else { return false }
        inProgress = false
        if success { grantedAt = now }
        return success
    }

    // 허용 상태만 폐기(진행 중 인증은 유지)
    mutating func expire() { grantedAt = nil }

    // 키 삭제 때 진행 중 인증과 허용 상태를 모두 무효화
    mutating func cancel() {
        generation &+= 1
        inProgress = false
        grantedAt = nil
    }

    // 경과가 300초 미만일 때만 유효. now 가 grantedAt 보다 앞서면(시계 이상) 무효
    func isValid(now: UInt64) -> Bool {
        guard let at = grantedAt, now >= at else { return false }
        return now - at < Self.limitNanos
    }
}

// 서명 실패의 오류 코드 분류. 근거는 SDK 헤더 SecBase.h·LAError.h
//  - 인증 실패·취소·상호작용 불가 = 재인증으로 복구되므로 unlock-required
//  - 키 항목 없음(errSecItemNotFound) = 서명 시점에 사라진 키라서 key-invalid
//  - 생체 잠금(biometryLockout)은 기기 암호 입력으로 풀리므로 영구 손상 아님
enum SignFailureKind: Equatable {
    case unlockRequired, keyInvalid, noLockScreen, signFailed
}

enum SignFailureClassifier {
    static func classify(domain: String, code: Int) -> SignFailureKind {
        if domain == "com.apple.LocalAuthentication" {
            switch code {
            case -1, -2, -4, -9, -10, -8, -1004: return .unlockRequired
            case -5: return .noLockScreen
            default: return .signFailed
            }
        }
        switch OSStatus(truncatingIfNeeded: code) {
        case errSecAuthFailed, errSecInteractionNotAllowed, errSecUserCanceled: return .unlockRequired
        case errSecItemNotFound: return .keyInvalid
        default: return .signFailed
        }
    }
}

// 알림 권한 상태에 따른 start 처리
enum StartDecision: Equatable {
    case succeed, deny, ask, pending
}

enum StartPolicy {
    static func decide(status: UNAuthorizationStatus, requestInFlight: Bool) -> StartDecision {
        if requestInFlight { return .pending }
        // ephemeral(App Clip 임시 허용)은 iOS 에만 존재
        #if os(iOS)
        if status == .ephemeral { return .succeed }
        #endif
        switch status {
        case .authorized, .provisional: return .succeed
        case .denied: return .deny
        default: return .ask
        }
    }
}

// 가림막 표시 조건. 앱 비활성화 또는 화면 녹화·미러링 중
enum ShieldPolicy {
    static func shouldCover(inactive: Bool, captured: Bool) -> Bool { inactive || captured }
}
