import { readAppTargets, setAppTargets } from "../app-targets.js";

export const readSameProcessAppTargets = () => readAppTargets();
export const setSameProcessAppTargets = (session, devices) => setAppTargets(session, devices);
