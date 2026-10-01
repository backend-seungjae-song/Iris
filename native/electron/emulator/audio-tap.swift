// 에뮬레이터 음량 도우미. 지정한 프로세스들의 소리를 원래 출력에서 끊고(음소거 탭) 정한 크기로 다시 출력
// 입력: 표준입력 JSON 한 줄씩 {"pids":[..],"volume":0~1,"muted":bool}. 표준입력이 닫히면 종료(탭은 프로세스와 함께 사라짐)
// 출력: 표준출력 JSON 한 줄씩 {"ok":bool,"error"?:string,"tapped"?:n}
// 조건: macOS 14.2 이상(Core Audio 프로세스 탭). 첫 탭 때 macOS 오디오 녹음 권한 창(Info.plist NSAudioCaptureUsageDescription)
// 컴파일: audio-volume.cjs 가 첫 사용 때 상태 폴더 캐시로
import CoreAudio
import AudioToolbox
import Foundation

final class Gain: @unchecked Sendable { var value: Float = 1 }
let gain = Gain()

func reply(_ dict: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: dict), let s = String(data: data, encoding: .utf8) {
    FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
  }
}

func systemProp<T>(_ sel: AudioObjectPropertySelector, _ fallback: T) -> T {
  var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value = fallback; var size = UInt32(MemoryLayout<T>.size)
  _ = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, $0) }
  return value
}

// PID → Core Audio 프로세스 객체. 소리를 한 번도 안 낸 프로세스는 아직 객체가 없음
func processObject(_ pid: pid_t) -> AudioObjectID? {
  var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var input = pid; var out = AudioObjectID(kAudioObjectUnknown); var size = UInt32(MemoryLayout<AudioObjectID>.size)
  let st = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, UInt32(MemoryLayout<pid_t>.size), &input, &size, &out)
  return st == noErr && out != kAudioObjectUnknown ? out : nil
}

func deviceUID(_ id: AudioObjectID) -> String? {
  var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var uid: Unmanaged<CFString>?; var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &uid) == noErr, let u = uid else { return nil }
  return u.takeRetainedValue() as String
}

final class Tap {
  var tapID = AudioObjectID(kAudioObjectUnknown)
  var aggregateID = AudioObjectID(kAudioObjectUnknown)
  var procID: AudioDeviceIOProcID?
  var objects: [AudioObjectID] = []
  var outputUID: String?
  var silent = false

  func stop() {
    if let p = procID { AudioDeviceStop(aggregateID, p); AudioDeviceDestroyIOProcID(aggregateID, p); procID = nil }
    if aggregateID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregateID); aggregateID = AudioObjectID(kAudioObjectUnknown) }
    if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID); tapID = AudioObjectID(kAudioObjectUnknown) }
    objects = []
    outputUID = nil
    silent = false
  }

  // 음소거에도 IOProc은 필요하지만 스피커를 포함할 필요는 없다.
  func start(_ objs: [AudioObjectID], silent: Bool) throws {
    stop()
    guard !objs.isEmpty else { return }
    let desc = CATapDescription(stereoMixdownOfProcesses: objs)
    desc.muteBehavior = .muted
    desc.isPrivate = true
    desc.name = "Iris emulator volume"
    var tap = AudioObjectID(kAudioObjectUnknown)
    var st = AudioHardwareCreateProcessTap(desc, &tap)
    guard st == noErr else { throw NSError(domain: "tap", code: Int(st)) }
    tapID = tap
    var outUID: String?
    var aggDesc: [String: Any] = [
      kAudioAggregateDeviceNameKey: "Iris emulator volume",
      kAudioAggregateDeviceUIDKey: "app.iris.emulator-volume." + UUID().uuidString,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: desc.uuid.uuidString]],
    ]
    if !silent {
      let output: AudioObjectID = systemProp(kAudioHardwarePropertyDefaultOutputDevice, AudioObjectID(kAudioObjectUnknown))
      guard let uid = deviceUID(output) else { stop(); throw NSError(domain: "output", code: -1) }
      outUID = uid
      aggDesc[kAudioAggregateDeviceMainSubDeviceKey] = uid
      aggDesc[kAudioAggregateDeviceSubDeviceListKey] = [[kAudioSubDeviceUIDKey: uid]]
    }
    var agg = AudioObjectID(kAudioObjectUnknown)
    st = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &agg)
    guard st == noErr else { stop(); throw NSError(domain: "aggregate", code: Int(st)) }
    aggregateID = agg
    var proc: AudioDeviceIOProcID?
    st = AudioDeviceCreateIOProcIDWithBlock(&proc, agg, nil) { _, input, _, output, _ in
      if silent { return }
      let ins = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
      let outs = UnsafeMutableAudioBufferListPointer(output)
      let g = gain.value
      for i in 0..<min(ins.count, outs.count) {
        guard let src = ins[i].mData, let dst = outs[i].mData else { continue }
        let n = Int(min(ins[i].mDataByteSize, outs[i].mDataByteSize)) / MemoryLayout<Float>.size
        let s = src.assumingMemoryBound(to: Float.self), d = dst.assumingMemoryBound(to: Float.self)
        for k in 0..<n { d[k] = s[k] * g }
      }
    }
    guard st == noErr, let p = proc else { stop(); throw NSError(domain: "ioproc", code: Int(st)) }
    procID = p
    // 버퍼 크게(약 20ms): 시스템 부하 때 처리 기한을 놓쳐 지지직거리는 것 방지. 실패해도 기본값으로 진행
    var frames: UInt32 = 1024
    var bufAddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyBufferFrameSize, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    _ = AudioObjectSetPropertyData(agg, &bufAddr, 0, nil, UInt32(MemoryLayout<UInt32>.size), &frames)
    st = AudioDeviceStart(agg, p)
    guard st == noErr else { stop(); throw NSError(domain: "start", code: Int(st)) }
    objects = objs
    outputUID = outUID
    self.silent = silent
  }
}

let tap = Tap()
while let line = readLine() {
  guard let data = line.data(using: .utf8),
        let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { reply(["ok": false, "error": "bad input"]); continue }
  let volume = max(0, min(1, (msg["volume"] as? Double) ?? 1))
  let muted = (msg["muted"] as? Bool) ?? false
  gain.value = muted ? 0 : Float(volume)
  let silent = muted || volume == 0
  let pids = (msg["pids"] as? [Int]) ?? []
  let objs = pids.compactMap { processObject(pid_t($0)) }.sorted()
  // 원래 크기면 가로채지 않음(권한·지연 없이 원래 출력 그대로)
  if (volume >= 1 && !muted) || objs.isEmpty {
    tap.stop(); reply(["ok": true, "tapped": 0]); continue
  }
  // 같은 프로세스·같은 출력 기기면 유지. 기본 출력 기기가 바뀌면(이어폰 연결 등) 새 기기로 다시 연결
  let currentOutput = silent ? nil : deviceUID(systemProp(kAudioHardwarePropertyDefaultOutputDevice, AudioObjectID(kAudioObjectUnknown)))
  if objs == tap.objects && currentOutput == tap.outputUID && silent == tap.silent { reply(["ok": true, "tapped": objs.count]); continue }
  do { try tap.start(objs, silent: silent); reply(["ok": true, "tapped": objs.count]) }
  catch { reply(["ok": false, "error": "\((error as NSError).domain) \((error as NSError).code)"]) }
}
tap.stop()
