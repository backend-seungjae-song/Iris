const ref = (input) => input?.tabId ?? input?.tabRef ?? input?.tab ?? "unknown";
const target = (input) => input?.target ?? input?.tabId ?? input?.device ?? "unknown";
const run = (identity, input) => identity?.run ?? input?.run ?? input?.runToken?.run ?? input?.token?.run ?? "unknown";
const ask = (input, request) => input?.requestId ?? request?.requestId ?? "unknown";

const definition = (identity, locks, mutates = true) => Object.freeze({ identity, locks, mutates });
const targetIdentity = (identity) => identity?.run || identity?.key
  ? ["session", "run", "key"] : ["session"];
const optionalRunIdentity = (identity) => identity?.run || identity?.key
  ? ["session", "run", "key"] : identity?.session ? ["session"] : [];
const legacyHostIdentity = (identity) => identity?.lifecycle === true
  ? ["session", "run"] : optionalRunIdentity(identity);

export const HOST_OPERATION_DEFINITIONS = Object.freeze({
  "browser.sessionView": definition([], ({ identity }) => [`session:${identity.session || "none"}`], false),
  "browser.targetGet": definition([], ({ identity }) => [`session:${identity.session || "none"}`], false),
  "browser.targetSet": definition(["session"], ({ identity, input }) => [`session:${identity.session}`, `tab:${ref(input)}`]),
  "browser.targetClear": definition(["session"], ({ identity, input }) => [`session:${identity.session}`, ...(input?.tabRef ? [`tab:${ref(input)}`] : [])]),
  "browser.commandGuard": definition([], ({ input }) => [`tab:${ref(input)}`], false),
  "browser.commandTargetState": definition([], ({ identity, input }) => [`session:${identity.session || "none"}`, ...(input?.tabRef ? [`tab:${ref(input)}`] : [])]),
  "browser.resolveForCommand": definition((identity, input) => input?.lifecycle ? ["session", "run"] : targetIdentity(identity),
    ({ identity, input }) => [`session:${identity.session}`, ...(input?.tabRef ? [`tab:${ref(input)}`] : [])], false),
  "browser.tabCreate": definition([], ({ identity }) => [`session:${identity.session || "none"}`]),
  "browser.tabWake": definition(["session"], ({ input }) => [`tab:${ref(input)}`]),
  "browser.tabClose": definition(["session"], ({ identity, input }) => [`session:${identity.session}`, `tab:${ref(input)}`]),
  "browser.status": definition([], () => [], false),
  "browser.promptTargetsActivate": definition(["session"], ({ identity }) => [`session:${identity.session}`, "app-targets"]),
  "browser.pickRecord": definition(["session"], ({ identity }) => [`session:${identity.session}`]),
  "browser.pickList": definition([], ({ identity }) => [`session:${identity.session || "none"}`], false),

  // 명령 단위 호출: 탭 잠금을 browser-dialog 의 단위 보유자가 단위 종료까지 쥠 (호출 사이에 옛 명령이 끼면 서로 기다림)
  "browser.executeWithDialog": definition((identity, input) => input?.lifecycle ? ["session", "run"] : targetIdentity(identity), ({ input }) => input?.relay?.unit ? [] : [`tab:${ref(input)}`]),
  "browser.dialogState": definition((identity, input) => input?.lifecycle ? ["session", "run"] : targetIdentity(identity), ({ input }) => [`tab:${ref(input)}`], false),
  "browser.dialogAnswer": definition((identity, input) => input?.lifecycle ? ["session", "run"] : targetIdentity(identity), ({ input }) => [`tab:${ref(input)}`]),
  "browser.legacyHostTask": definition(legacyHostIdentity, ({ input }) => [`tab:${ref(input)}`]),
  "qa.anchorUpdate": definition(identity => identity?.lifecycle === true ? ["session", "run"] : targetIdentity(identity),
    ({ identity, input }) => [`run:${identity.run || input?.runId || "unknown"}`]),

  "qa.claimIfFree": definition(["session", "run", "key"], ({ input }) => [`qa:${target(input)}`]),
  "qa.releaseIfOwner": definition(["session", "run", "key"], ({ input }) => [`qa:${target(input)}`]),
  "qa.owner": definition([], ({ input }) => [`qa:${target(input)}`], false),
  "qa.tabCreate": definition(["session", "run", "key"], ({ identity }) => [`run:${identity.run}`]),
  "qa.tabsRestore": definition(["session", "run", "key"], ({ identity }) => [`session:${identity.session}`, `run:${identity.run}`]),
  "qa.tabClose": definition(["session", "run", "key"], ({ identity, input }) => [`run:${identity.run}`, `tab:${ref(input)}`, `qa:${ref(input)}`]),
  "qa.tabsPublish": definition(["session", "run", "key"], ({ identity }) => [`run:${identity.run}`]),
  "qa.deviceAuthorize": definition(["session", "run", "key"], ({ input }) => ["app-targets", `qa:device:${input?.device ?? "unknown"}`]),
  "app.targetsGet": definition([], () => ["app-targets"], false),
  "app.targetsAll": definition(["session", "run", "key"], () => ["app-targets"], false),
  "app.targetsSet": definition(["session"], () => ["app-targets"]),
  "app.command": definition([], ({ input }) => {
    if (input?.command === "list") return [];
    const device = input?.device ?? input?.args?.device ?? "unassigned";
    return [`app-device:${device}`];
  }),
  "qa.askUser": definition(targetIdentity, ({ input, request }) => [`ask:${ask(input, request)}`]),
  "qa.reportOpen": definition(targetIdentity, ({ identity }) => [`session:${identity.session}`, ...(identity.run ? [`run:${identity.run}`] : [])]),

  "journal.sessionCommand": definition(["session"], ({ identity }) => [identity.run ? `run:${identity.run}` : `session:${identity.session}`]),
  "journal.accept": definition(optionalRunIdentity, ({ identity }) => [identity.run ? `run:${identity.run}` : `session:${identity.session || "none"}`]),
  "journal.complete": definition([], ({ identity, input }) => [`run:${run(identity, input)}`]),
  "journal.release": definition([], ({ identity, input }) => [`run:${run(identity, input)}`]),
  "journal.trace": definition([], ({ identity }) => [`session:${identity.session || "none"}`]),
  "journal.recordFrame": definition([], ({ identity, input }) => [`run:${run(identity, input)}`]),
  "journal.surfaces": definition(optionalRunIdentity, ({ identity }) => [identity.run ? `run:${identity.run}` : `session:${identity.session || "none"}`], false),
  "lease.grant": definition(targetIdentity, ({ identity }) => [identity.run ? `run:${identity.run}` : `session:${identity.session}`]),
  "lease.check": definition(targetIdentity, ({ identity }) => [identity.run ? `run:${identity.run}` : `session:${identity.session}`], false),
  "lease.revoke": definition(targetIdentity, ({ identity }) => [identity.run ? `run:${identity.run}` : `session:${identity.session}`]),
  "user.ask": definition([], ({ input, request }) => [`ask:${ask(input, request)}`]),
  "user.notify": definition([], ({ identity }) => [`session:${identity.session || "none"}`]),
  "user.progress": definition([], ({ identity }) => [`session:${identity.session || "none"}`]),
});

export const HOST_OPERATION_NAMES = Object.freeze(Object.keys(HOST_OPERATION_DEFINITIONS));
