import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import envModule from "../env.cjs";
import { snapshot, subscribeRuntimeState } from "../runtime-state.js";
import { createAgentSocketServer } from "./agent-socket.js";
import { createAgentStore } from "./agents.js";
import { createConnectionAuth } from "./auth.js";
import { prepareGatewayCertificate } from "./certificate.js";
import { REMOTE_RPC_VERSION } from "./contract/ipc.js";
import { createChannelRuntime } from "./channel-runtime.js";
import { createQuestionHookInstaller } from "./installer.js";
import { handleRemoteLocalApi } from "./local-api.js";
import { createMessageBridge } from "./messaging.js";
import { resolveTailscaleAddress } from "./network.js";
import { createTailscaleSetup, PHONE_INSTALL_URL } from "./tailscale-setup.js";
import { messageFor as messageText } from "./messages.js";
import { createPairing, qrRows } from "./pairing.js";
import { createPinStore } from "./pin.js";
import { createRequestStore } from "./requests.js";
import { createRegistry } from "./registry.js";
import { createRemoteRpcHost } from "./rpc-host.js";
import { createSessionPolicyStore } from "./session-policy.js";

const { portWithLegacy } = envModule;
const copy = (value) => structuredClone(value);
const QUESTION_HOOK_PATH = fileURLToPath(new URL("./hooks/ask-question.mjs", import.meta.url));
const messageFor = (code) => messageText(code, "원격 제어를 사용할 수 없습니다.");

export function remoteConnectionCloseLog(event) {
  if (event?.type !== "conn.closed") return null;
  const reason = /^[a-z0-9-]{1,64}$/.test(event.reason || "") ? event.reason : "internal-error";
  return `[remote] close reason=${reason}`;
}

export function createRemoteLifecycle(options) {
  const ctx = options?.ctx;
  const subscribeFeatureState = options?.onFeatureStateSaved;
  if (!ctx || typeof ctx.onShutdown !== "function" || typeof subscribeFeatureState !== "function") {
    throw new TypeError("remote lifecycle dependencies are incomplete");
  }
  const registry = options.registry || createRegistry();
  const pinStore = options.pinStore || createPinStore(options.pinOptions);
  const sessionPolicy = options.sessionPolicy || createSessionPolicyStore(options.sessionPolicyOptions);
  const prepareCertificate = options.prepareCertificate || prepareGatewayCertificate;
  const resolveAddress = options.resolveAddress || resolveTailscaleAddress;
  const getServerPort = options.getServerPort || portWithLegacy;
  const random = options.randomBytes || randomBytes;
  const log = options.log || console.log;
  const configuredAudit = options.rpcOptions?.onAudit;
  const serverInstance = random(16).toString("hex");
  const messageBridge = options.messageBridge || createMessageBridge({
    ...(options.messageOptions || {}),
    getHerdr: () => ctx.herdr,
  });
  const agentStore = options.agentStore || createAgentStore({
    getHerdr: () => ctx.herdr,
    getSnapshot: options.getRuntimeSnapshot || snapshot,
    subscribeSnapshot: options.subscribeRuntimeState || subscribeRuntimeState,
    orderWorkspaces: options.orderWorkspaces || ctx.spaceOrder?.orderWorkspaces,
    subscribeSpaceOrder: options.subscribeSpaceOrder || ctx.spaceOrder?.subscribe,
    randomBytes: random,
    canMessage: messageBridge.canMessage,
  });
  const requestStore = options.requestStore || createRequestStore({
    ...(options.requestOptions || {}),
    randomBytes: random,
    agentRefForPane: agentStore.refForPane,
  });
  const agentSocket = options.agentSocket || createAgentSocketServer({
    agents: agentStore,
    requests: requestStore,
    isRemoteEnabled: () => isRemoteEnabled(),
    hasRegisteredDevices: () => registry.effectiveState().devices.length > 0,
    onChannelsChanged: agentStore.changed,
  });
  const channelRuntime = options.channelRuntime || createChannelRuntime({ socketPath: agentSocket.socketPath });
  const installer = options.installer || createQuestionHookInstaller({
    hookPath: QUESTION_HOOK_PATH,
    socketPath: agentSocket.socketPath,
  });
  let certificateHash = null;
  let rpcHost = null;
  let initialized = false;
  let featureHidden = false;
  let generation = 0;
  let unregisterClaudeChannel = null;
  let agentStopPromise = Promise.resolve();
  let state = {
    type: "remote.state",
    status: "off",
    busy: true,
    enabled: false,
    error: null,
    listener: null,
    certHash: null,
    devices: [],
    pairing: null,
    agents: agentStore.list(),
    requests: requestStore.list(),
    questionHookInstalled: false,
    cleanShutdownRecorded: false,
    pinConfigured: false,
    pausedForPin: false,
    pinIdleMinutes: 30,
  };

  function publicDevices() {
    return registry.snapshot().devices.map(({ deviceId, name, addedAt }) => ({ deviceId, name, addedAt }));
  }

  function isRemoteEnabled() {
    return registry.status().valid
      && registry.effectiveState().enabled
      && state.status === "on";
  }

  function publicAvailability() {
    if (!pinStore.hasPin()) return "pin-required";
    return registry.effectiveState().enabled ? "enabled" : "sharing-disabled";
  }

  function availabilityIsCurrent(value) {
    if (featureHidden || !registry.status().valid) return false;
    if (value === "enabled") return publicAvailability() === value;
    return registry.effectiveState().devices.length > 0 && publicAvailability() === value;
  }

  const auth = options.auth || createConnectionAuth({
    serverInstance,
    getCertificateHash: () => certificateHash,
    getDevice(deviceId) {
      return registry.effectiveState().devices.find((device) => device.deviceId === deviceId) || null;
    },
    isRemoteEnabled,
    verifyPin: (pin, identity) => pinStore.verify(pin, identity),
    getIdleMs: () => sessionPolicy.getPinIdleMinutes() * 60_000,
    onExpire(connId, reason) { rpcHost?.closeConnection?.(connId, reason); },
  });

  function setState(patch) {
    state = { ...state, ...patch };
    state.enabled = state.status === "on";
    ctx.visitClients?.((client) => { sendState(client); });
  }

  const pairing = options.pairing || createPairing({
    ...(options.pairingOptions || {}),
    onChange(value) { setState({ pairing: value }); },
  });

  function sendState(ws) {
    if (!ws?._local || !ws?._ui || ws.readyState === 0 || ws.readyState > 1) return false;
    try {
      ws.send(JSON.stringify(copy(state)));
      return true;
    } catch {
      return false;
    }
  }

  function errorState(code, action) {
    pairing.discard();
    setState({
      status: "error",
      busy: false,
      listener: null,
      error: { code, message: messageFor(code), action },
    });
  }

  function closeSessions(scope, reason) {
    for (const connId of auth.invalidate(scope)) rpcHost?.closeConnection?.(connId, reason);
  }

  function stopRuntime(reason) {
    pairing.discard();
    requestStore.notifyRemoteDisabled();
    unregisterClaudeChannel?.();
    unregisterClaudeChannel = null;
    channelRuntime.stop();
    agentStopPromise = agentSocket.stop().catch(() => false);
    closeSessions({ scope: "all" }, reason);
    try {
      return rpcHost?.stop?.() !== false;
    } catch {
      return false;
    }
  }

  function onGatewayStatus(event) {
    if (event.type === "starting" || event.type === "restarting") {
      pairing.discard();
      if (state.status === "on") setState({ busy: true, listener: null });
    } else if (event.type === "listening" && isRemoteEnabled()) {
      setState({ busy: false, listener: { address: event.address, port: event.port } });
    }
  }

  async function stopAndDisable({ reason, errorCode = null, successStatus = "off" }) {
    const currentGeneration = ++generation;
    const stopped = stopRuntime(reason);
    if (!initialized) return { ok: false, error: "initializing" };
    const changed = registry.change({ type: "disable" });
    if (!changed.ok) {
      errorState(changed.error, "stop");
      return changed;
    }
    const saved = changed.unchanged && !registry.status().dirty
      ? { ok: true, unchanged: true }
      : await registry.save();
    if (!saved.ok) {
      errorState("registry-save-failed", "stop");
      return saved;
    }
    if (!stopped) {
      errorState("gateway-stop-failed", "stop");
      return { ok: false, error: "gateway-stop-failed" };
    }
    await agentStopPromise;
    if (currentGeneration !== generation) return { ok: false, error: "superseded" };
    if (errorCode) errorState(errorCode, "enable");
    else setState({ status: successStatus, busy: false, listener: null, error: null });
    return { ok: true };
  }

  function onGatewayFailureLimit(event = {}) {
    const code = event.code === "gateway-stop-failed" ? "gateway-stop-failed" : "gateway-restart-limit";
    ++generation;
    stopRuntime(code);
    errorState(code, "enable");
  }

  rpcHost = options.rpcHost || (options.createRpcHost || createRemoteRpcHost)({
    serverInstance,
    auth,
    getHerdr: () => ctx.herdr,
    agentStore,
    requestStore,
    messageBridge,
    broadcast: ctx.broadcast,
    ...(options.rpcOptions || {}),
    onAudit(event) {
      configuredAudit?.(event);
      const line = remoteConnectionCloseLog(event);
      if (line) log(line);
    },
    onPairRequest(entry, message) { return pairing.request(entry, message); },
    onStatus: onGatewayStatus,
    onFailureLimit: onGatewayFailureLimit,
  });

  async function startService(currentGeneration, availability = "enabled") {
    const statusOnly = availability !== "enabled";
    try {
      const network = await resolveAddress(options.networkOptions);
      if (currentGeneration !== generation || !availabilityIsCurrent(availability)) {
        return { ok: false, error: "superseded" };
      }
      let certificate;
      try {
        certificate = await prepareCertificate(options.certificateOptions);
      } catch (cause) {
        throw Object.assign(cause instanceof Error ? cause : new Error("certificate failed"), { code: "certificate-failed" });
      }
      if (currentGeneration !== generation || !availabilityIsCurrent(availability)) {
        return { ok: false, error: "superseded" };
      }
      certificateHash = certificate.certHash;
      const gatewayPort = Number(getServerPort()) + 1;
      if (!Number.isSafeInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) {
        throw Object.assign(new Error("gateway port is invalid"), { code: "gateway-start-failed" });
      }
      const listening = await rpcHost.start({
        type: "configure",
        v: REMOTE_RPC_VERSION,
        serverInstance,
        address: network.address,
        port: gatewayPort,
        keyPem: certificate.keyPem,
        certPem: certificate.certPem,
        certHash: certificate.certHash,
        tailscalePath: network.executable,
        availability,
      });
      if (currentGeneration !== generation || !availabilityIsCurrent(availability)) {
        rpcHost.stop();
        return { ok: false, error: "superseded" };
      }
      if (statusOnly) {
        setState({
          status: "off",
          busy: false,
          error: null,
          listener: null,
          certHash: certificate.certHash,
          pausedForPin: availability === "pin-required",
        });
        return { ok: true, statusOnly: true };
      }
      try {
        await agentStopPromise;
        await agentSocket.start();
        await channelRuntime.start();
        unregisterClaudeChannel = registerClaudeMessageChannel(agentSocket.channel);
      } catch (cause) {
        channelRuntime.stop();
        void agentSocket.stop().catch(() => {});
        throw Object.assign(cause instanceof Error ? cause : new Error("agent socket failed"), { code: "agent-socket-failed" });
      }
      if (currentGeneration !== generation || !availabilityIsCurrent(availability)) {
        stopRuntime("superseded");
        return { ok: false, error: "superseded" };
      }
      setState({
        status: "on",
        busy: false,
        error: null,
        listener: { address: listening.address, port: listening.port },
        certHash: certificate.certHash,
        pausedForPin: false,
      });
      return { ok: true };
    } catch (cause) {
      if (currentGeneration !== generation) return { ok: false, error: "superseded" };
      rpcHost.stop();
      const known = new Set([
        "tailscale-cli-not-found",
        "tailscale-address-unavailable",
        "tailscale-address-mismatch",
        "certificate-failed",
        "gateway-restart-limit",
        "agent-socket-failed",
      ]);
      const code = known.has(cause?.code) ? cause.code : "gateway-start-failed";
      if (statusOnly) {
        setState({ status: "off", busy: false, listener: null, error: null,
          pausedForPin: availability === "pin-required" });
      } else {
        errorState(code, "enable");
      }
      return { ok: false, error: code };
    }
  }

  function startStatusService() {
    const availability = publicAvailability();
    if (availability === "enabled" || registry.effectiveState().devices.length === 0) {
      return Promise.resolve({ ok: true, unchanged: true });
    }
    return startService(++generation, availability);
  }

  async function requestEnable() {
    if (!initialized) return { ok: false, error: "initializing" };
    if (featureHidden) return { ok: false, error: "feature-hidden" };
    if (!registry.status().valid) return { ok: false, error: "registry-invalid" };
    if (!pinStore.hasPin()) return { ok: false, error: "pin-required" };
    if (isRemoteEnabled() && !state.busy) return { ok: true, unchanged: true };
    const currentGeneration = ++generation;
    setState({ busy: true, error: null });
    const changed = registry.change({ type: "enable" });
    if (!changed.ok) {
      errorState(changed.error, "enable");
      return changed;
    }
    const saved = changed.unchanged && !registry.status().dirty
      ? { ok: true, unchanged: true }
      : await registry.save();
    if (!saved.ok) {
      stopRuntime("registry-save-failed");
      registry.change({ type: "disable" });
      errorState("registry-save-failed", "stop");
      return saved;
    }
    if (currentGeneration !== generation || featureHidden) return { ok: false, error: "superseded" };
    stopRuntime("remote-enabling");
    await agentStopPromise;
    if (currentGeneration !== generation || featureHidden) return { ok: false, error: "superseded" };
    return startService(currentGeneration);
  }

  async function requestDisable(optionsForDisable = {}) {
    const result = await stopAndDisable({ reason: optionsForDisable.reason || "remote-disabled" });
    if (result.ok && !featureHidden) await startStatusService();
    return result;
  }

  async function retryStop() {
    const result = await stopAndDisable({ reason: "remote-stop-retry" });
    if (result.ok && !featureHidden) await startStatusService();
    return result;
  }

  async function requestRegistryChange(operation, reason = operation?.type) {
    if (!initialized) return { ok: false, error: "initializing" };
    if (operation?.type === "enable") return requestEnable();
    if (operation?.type === "disable") return requestDisable({ reason });
    if (!operation || !["add-device", "remove-device"].includes(operation.type)) {
      return { ok: false, error: "invalid-operation" };
    }
    const changed = registry.change(operation);
    if (!changed.ok) return changed;
    if (operation.type === "remove-device" && !changed.unchanged) {
      closeSessions({ scope: "device", deviceId: operation.deviceId }, reason || "device-removed");
      agentSocket.refreshAvailability?.();
    }
    const saved = changed.unchanged && !registry.status().dirty
      ? { ok: true, unchanged: true }
      : await registry.save();
    if (!saved.ok) {
      ++generation;
      stopRuntime("registry-save-failed");
      registry.change({ type: "disable" });
      errorState("registry-save-failed", "stop");
    } else {
      setState({ devices: publicDevices() });
      if (state.status !== "on" && registry.effectiveState().devices.length === 0) stopRuntime("no-registered-devices");
    }
    return saved;
  }

  function requestPairStart() {
    if (!initialized) return { ok: false, error: "initializing" };
    if (featureHidden || state.status !== "on" || state.busy || !state.listener || !state.certHash) {
      return { ok: false, error: "pairing-unavailable" };
    }
    return pairing.start({ ...state.listener, certHash: state.certHash });
  }

  async function requestPairConfirm(code) {
    const confirmed = pairing.confirm(code);
    if (!confirmed.ok) return confirmed;
    return requestRegistryChange({ type: "add-device", device: confirmed.device }, "device-added");
  }

  function requestPairCancel() {
    return pairing.cancel();
  }

  async function setAccessPin(pin, confirmation) {
    if (!initialized) return { ok: false, error: "initializing" };
    if (pin !== confirmation) return { ok: false, error: "pin-mismatch" };
    const result = await pinStore.set(pin);
    if (!result.ok) return result;
    closeSessions({ scope: "all" }, "pin-changed");
    setState({ pinConfigured: true, pausedForPin: false });
    let resumed = false;
    if (!featureHidden && registry.effectiveState().enabled && state.status !== "on") {
      stopRuntime("pin-changed");
      await agentStopPromise;
      const currentGeneration = ++generation;
      setState({ status: "off", busy: true, listener: null, error: null });
      const started = await startService(currentGeneration);
      resumed = started.ok && state.status === "on";
    } else if (!featureHidden && state.status !== "on") {
      stopRuntime("pin-changed");
      await agentStopPromise;
      await startStatusService();
    }
    return { ok: true, configured: true, resumed };
  }

  async function setPinIdleMinutes(minutes) {
    if (!initialized) return { ok: false, error: "initializing" };
    // 바꾸기 전 기한으로 만료 확정. 기한을 늘려도 이미 끝난 토큰이 다시 살아나지 않게
    auth.pruneExpiredTokens();
    const result = await sessionPolicy.set(minutes);
    if (!result.ok) return result;
    const expired = auth.refreshExpiry();
    for (const connId of expired) rpcHost?.closeConnection?.(connId, "idle-timeout");
    setState({ pinIdleMinutes: result.pinIdleMinutes });
    return { ok: true, pinIdleMinutes: result.pinIdleMinutes, expired: expired.length };
  }

  async function installQuestionHook() {
    const result = await installer.install();
    if (result.ok) setState({ questionHookInstalled: true });
    return result;
  }

  async function removeQuestionHook() {
    const result = await installer.remove();
    if (result.ok) setState({ questionHookInstalled: false });
    return result;
  }

  function answerRequest(request, answer) {
    return requestStore.answer(request, answer);
  }

  function registerClaudeMessageChannel(channel) {
    const unregister = messageBridge.registerClaudeMessageChannel(channel);
    agentStore.changed();
    return () => {
      unregister();
      agentStore.changed();
    };
  }

  function onFeatureSaved(saved) {
    if (!saved.hidden.includes("remote")) return;
    featureHidden = true;
    if (initialized) void stopAndDisable({ reason: "feature-hidden" });
    else {
      ++generation;
      stopRuntime("feature-hidden");
    }
  }

  const unsubscribeFeatureState = subscribeFeatureState(onFeatureSaved);
  const unsubscribeAgents = agentStore.subscribe(() => setState({ agents: agentStore.list() }));
  const unsubscribeRequests = requestStore.subscribe(() => setState({ requests: requestStore.list() }));

  // Tailscale 준비 상태. 조회는 화면 요청과 작업 상태 변화 때만
  const tailscale = options.tailscale || createTailscaleSetup({
    ...(options.tailscaleOptions || {}),
    onChange() { ctx.visitClients?.((client) => { void sendTailscale(client); }); },
  });
  let phoneInstallQr = null;
  try { phoneInstallQr = qrRows(PHONE_INSTALL_URL); } catch {}

  async function sendTailscale(ws) {
    if (!ws?._local || !ws?._ui || ws.readyState === 0 || ws.readyState > 1) return false;
    const value = await tailscale.status();
    const error = value.error ? { code: value.error, message: messageText(value.error) } : null;
    try {
      ws.send(JSON.stringify({ type: "remote.tailscale", ...value, error, phoneInstallQr }));
      return true;
    } catch {
      return false;
    }
  }

  function tailscaleAction(name) {
    return () => {
      if (featureHidden) return { ok: false, error: "feature-hidden" };
      return tailscale[name]();
    };
  }

  function shutdown() {
    ++generation;
    tailscale.close();
    unsubscribeFeatureState();
    unsubscribeAgents();
    unsubscribeRequests();
    const stopped = stopRuntime("server-shutdown");
    const saved = !initialized || !registry.status().valid || registry.saveSync();
    const cleanShutdownRecorded = stopped && saved && registry.markCleanShutdownSync();
    agentStore.close();
    requestStore.close();
    state = {
      ...state,
      status: cleanShutdownRecorded ? "off" : "error",
      busy: false,
      enabled: false,
      listener: null,
      error: cleanShutdownRecorded ? null : { code: stopped ? "registry-save-failed" : "gateway-stop-failed",
        message: messageFor(stopped ? "registry-save-failed" : "gateway-stop-failed"), action: "stop" },
      cleanShutdownRecorded,
    };
    return cleanShutdownRecorded;
  }

  ctx.onShutdown(shutdown);

  const ready = (async () => {
    const [result, pinResult, policyResult] = await Promise.all([
      registry.initialize(),
      pinStore.initialize(),
      sessionPolicy.initialize(),
    ]);
    initialized = true;
    setState({ questionHookInstalled: await installer.isInstalled() });
    if (!result.ok) {
      errorState(result.error || "registry-invalid", result.error === "registry-save-failed" ? "stop" : "enable");
      return result;
    }
    if (!pinResult.ok) {
      errorState(pinResult.error || "pin-invalid", "enable");
      return pinResult;
    }
    if (!policyResult.ok) {
      errorState(policyResult.error || "session-policy-invalid", "enable");
      return policyResult;
    }
    setState({
      devices: publicDevices(),
      pinConfigured: pinStore.hasPin(),
      pausedForPin: registry.effectiveState().enabled && !pinStore.hasPin(),
      pinIdleMinutes: policyResult.pinIdleMinutes,
    });
    if (featureHidden) {
      await stopAndDisable({ reason: "feature-hidden" });
      return result;
    }
    if (!registry.effectiveState().enabled) {
      setState({ status: "off", busy: false, listener: null, error: null });
      await startStatusService();
      return result;
    }
    if (!pinStore.hasPin()) {
      setState({ status: "off", busy: false, listener: null, error: null });
      await startStatusService();
      return result;
    }
    const currentGeneration = ++generation;
    setState({ status: "off", busy: true, listener: null, error: null });
    await startService(currentGeneration);
    return result;
  })();

  const lifecycle = {
    ready,
    getState: () => copy(state),
    isRemoteEnabled,
    sendState,
    requestEnable,
    requestDisable,
    retryStop,
    requestPairStart,
    requestPairConfirm,
    requestPairCancel,
    setAccessPin,
    setPinIdleMinutes,
    installQuestionHook,
    removeQuestionHook,
    sendTailscale,
    installTailscale: tailscaleAction("install"),
    startTailscale: tailscaleAction("start"),
    connectTailscale: tailscaleAction("connect"),
    answerRequest,
    requestRegistryChange,
    addDevice: (device) => requestRegistryChange({ type: "add-device", device }, "device-added"),
    removeDevice: (deviceId) => requestRegistryChange({ type: "remove-device", deviceId }, "device-removed"),
    shutdown,
    requests: requestStore,
    registerClaudeMessageChannel,
    serverInstance,
    handle(ws, message) { return handleRemoteLocalApi(ws, message, lifecycle); },
  };
  return lifecycle;
}
