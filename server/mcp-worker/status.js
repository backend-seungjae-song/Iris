export function createWorkerStatus({ deployId, workerGeneration, activity, pid = process.pid, now = () => new Date() }) {
  const startedAt = now().toISOString();
  let state = "starting";
  let failure = null;
  return {
    setState(next, error) {
      state = next;
      failure = error ? String(error.message || error) : null;
    },
    get() {
      return {
        deployId, pid, workerGeneration, state,
        accepting: state === "accepting" && activity.isAccepting(),
        startedAt, active: activity.snapshot(),
        ...(failure ? { failure } : {}),
      };
    },
  };
}
