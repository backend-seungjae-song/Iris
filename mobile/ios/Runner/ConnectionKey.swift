import Flutter
import LocalAuthentication
import Security

// 채널 iris.remote/connection_key. Secure Enclave P-256 키, 추출 불가
// 안드로이드 ConnectionKey.kt 와 같은 메서드·오류 코드
final class ConnectionKey {
    // v2 키는 서명할 때 폰 잠금 확인을 요구하지 않는다. 키 설정은 만든 뒤 바꿀 수 없어 이전 키를 지우고 새로 만든다
    private static let keyTag = Data("iris.remote.connection-key.v2".utf8)
    private static let legacyTag = Data("iris.remote.connection-key".utf8)
    // 인증 재사용 300초는 안드로이드 setUserAuthenticationParameters(300) 과 같음
    // 시간 판정은 단조 시계(NativeLogic.swift UnlockTracker), 시스템 시각 변경 무관
    private var tracker = UnlockTracker()
    private var pendingContext: LAContext?
    private var unlockedContext: LAContext?

    func register(messenger: FlutterBinaryMessenger) {
        let channel = FlutterMethodChannel(name: "iris.remote/connection_key", binaryMessenger: messenger)
        channel.setMethodCallHandler { [weak self] call, result in
            guard let self else { return }
            switch call.method {
            case "publicKey": self.publicKey(result)
            case "hasKey": self.hasKey(result)
            case "unlock": result(nil)
            case "sign": self.sign(call, result)
            case "deleteKey": self.deleteKey(result)
            default: result(FlutterMethodNotImplemented)
            }
        }
    }

    private func fail(_ result: FlutterResult, _ code: String, _ message: String?) {
        result(FlutterError(code: code, message: message, details: nil))
    }

    // 잠금(기기 암호) 없음 = no-lock-screen, 그 외 사용 불가 = 해당 오류
    private func lockState() -> LAError.Code? {
        var error: NSError?
        if LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) { return nil }
        return LAError.Code(rawValue: error?.code ?? LAError.notInteractive.rawValue)
    }

    // MARK: hasKey

    // 이전 버전의 잠금 확인 요구 키는 지우고, 이 기기에 새 키가 있는지 알려 준다
    private func hasKey(_ result: FlutterResult) {
        SecItemDelete([
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: Self.legacyTag,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        ] as CFDictionary)
        do {
            result(try existingKey() != nil)
        } catch {
            fail(result, "key-unavailable", error.localizedDescription)
        }
    }

    // MARK: publicKey

    private func publicKey(_ result: FlutterResult) {
        if lockState() == .passcodeNotSet {
            fail(result, "no-lock-screen", "폰 잠금이 설정되어 있지 않습니다.")
            return
        }
        #if targetEnvironment(simulator)
        // 시뮬레이터에는 Secure Enclave 가 없음. 소프트웨어 키로 대체하지 않음
        fail(result, "key-unavailable", "이 기기에서는 연결 키를 만들 수 없습니다.")
        return
        #else
        do {
            let privateKey = try existingKey() ?? createKey()
            guard let publicKey = SecKeyCopyPublicKey(privateKey),
                  let point = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?,
                  let spki = SpkiEncoder.wrap(x963Point: point)
            else {
                fail(result, "key-unavailable", "연결 키 공개키를 읽을 수 없습니다.")
                return
            }
            result(spki.base64EncodedString())
        } catch {
            fail(result, "key-unavailable", error.localizedDescription)
        }
        #endif
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: Self.keyTag,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        ]
    }

    // 인증 없이 키 참조만 읽음(서명할 때 인증). context 를 주면 그 인증을 재사용
    private func existingKey(context: LAContext? = nil) throws -> SecKey? {
        var query = baseQuery()
        query[kSecReturnRef as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        if let context { query[kSecUseAuthenticationContext as String] = context }
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let item else { throw KeyError.status(status) }
        return (item as! SecKey)
    }

    private func createKey() throws -> SecKey {
        var accessError: Unmanaged<CFError>?
        // 기기 암호가 있을 때만 존재, 키는 Secure Enclave 안에서 꺼낼 수 없음
        guard let access = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
            [.privateKeyUsage],
            &accessError
        ) else { throw accessError!.takeRetainedValue() as Error }
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: Self.keyTag,
                kSecAttrAccessControl as String: access,
            ] as [String: Any],
        ]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
            throw error!.takeRetainedValue() as Error
        }
        return key
    }

    private enum KeyError: Error { case status(OSStatus) }

    // MARK: unlock

    private func unlock(_ result: @escaping FlutterResult) {
        guard let generation = tracker.begin() else {
            fail(result, "unlock-in-progress", "폰 잠금 확인이 이미 열려 있습니다.")
            return
        }
        if let state = lockState() {
            _ = tracker.finish(generation: generation, success: false, now: 0)
            if state == .passcodeNotSet {
                fail(result, "no-lock-screen", "폰 잠금이 설정되어 있지 않습니다.")
            } else {
                fail(result, "unlock-unavailable", "폰 잠금을 사용할 수 없습니다.")
            }
            return
        }
        let context = LAContext()
        pendingContext = context
        context.evaluatePolicy(
            .deviceOwnerAuthentication,
            localizedReason: "폰 잠금을 해제해 연결 키를 사용하세요"
        ) { [weak self] success, error in
            DispatchQueue.main.async {
                guard let self else { return }
                let now = MonotonicClock.nanos()
                // 삭제·만료로 취소된 세대의 늦은 콜백은 무시
                guard self.tracker.finish(generation: generation, success: success, now: now) else {
                    if self.pendingContext === context { self.pendingContext = nil }
                    context.invalidate()
                    if generation == self.tracker.generation {
                        self.fail(result, "unlock-canceled", error?.localizedDescription)
                    } else {
                        self.fail(result, "unlock-canceled", "연결 키가 삭제되어 인증을 취소했습니다.")
                    }
                    return
                }
                self.pendingContext = nil
                self.unlockedContext?.invalidate()
                self.unlockedContext = context
                self.scheduleExpiry()
                result(nil)
            }
        }
    }

    // 만료 시각에 컨텍스트 폐기. asyncAfter 는 잠자기를 세지 않으므로 사용 시점 검사(validContext)가 정본
    private func scheduleExpiry() {
        let at = tracker.grantedAt
        DispatchQueue.main.asyncAfter(deadline: .now() + 300) { [weak self] in
            guard let self, self.tracker.grantedAt == at, !self.tracker.isValid(now: MonotonicClock.nanos()) else { return }
            self.dropContext()
        }
    }

    private func validContext() -> LAContext? {
        guard let context = unlockedContext, tracker.isValid(now: MonotonicClock.nanos()) else {
            dropContext()
            return nil
        }
        return context
    }

    // 인증 완료된 컨텍스트만 폐기(진행 중 인증은 유지)
    private func dropContext() {
        tracker.expire()
        unlockedContext?.invalidate()
        unlockedContext = nil
    }

    // 키 삭제용. 진행 중 인증도 취소하고 늦은 콜백은 세대 번호로 무시
    private func cancelAllUnlock() {
        tracker.cancel()
        pendingContext?.invalidate()
        pendingContext = nil
        dropContext()
    }

    // MARK: sign

    private func sign(_ call: FlutterMethodCall, _ result: FlutterResult) {
        guard let args = call.arguments as? [String: Any],
              let bytes = args["bytes"] as? FlutterStandardTypedData
        else {
            fail(result, "invalid-arguments", "서명할 바이트가 없습니다.")
            return
        }
        #if targetEnvironment(simulator)
        fail(result, "key-unavailable", "이 기기에서는 연결 키를 사용할 수 없습니다.")
        return
        #else
        // v2 키는 서명할 때 잠금 확인을 요구하지 않아 이전 인증 컨텍스트가 필요 없음
        do {
            guard let key = try existingKey() else {
                fail(result, "key-unavailable", "연결 키를 찾을 수 없습니다.")
                return
            }
            var error: Unmanaged<CFError>?
            guard let signature = SecKeyCreateSignature(
                key, .ecdsaSignatureMessageX962SHA256, bytes.data as CFData, &error
            ) as Data? else {
                signFailure(result, error!.takeRetainedValue())
                return
            }
            result(signature.base64EncodedString())
        } catch KeyError.status(let status) {
            signFailure(result, NSError(domain: NSOSStatusErrorDomain, code: Int(status)))
        } catch {
            fail(result, "sign-failed", error.localizedDescription)
        }
        #endif
    }

    private func signFailure(_ result: FlutterResult, _ error: Error) {
        let nsError = error as NSError
        switch SignFailureClassifier.classify(domain: nsError.domain, code: nsError.code) {
        case .unlockRequired:
            dropContext()
            fail(result, "unlock-required", "폰 잠금 확인이 필요합니다.")
        case .keyInvalid:
            fail(result, "key-invalid", "연결 키를 다시 등록해야 합니다.")
        case .noLockScreen:
            fail(result, "no-lock-screen", "폰 잠금이 설정되어 있지 않습니다.")
        case .signFailed:
            fail(result, "sign-failed", nsError.localizedDescription)
        }
    }

    // MARK: deleteKey

    private func deleteKey(_ result: FlutterResult) {
        cancelAllUnlock()
        let status = SecItemDelete(baseQuery() as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            result(nil)
        } else {
            fail(result, "delete-failed", "키 삭제 실패 (\(status))")
        }
    }
}
