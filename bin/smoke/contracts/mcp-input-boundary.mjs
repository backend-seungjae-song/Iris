const INPUT_BASE_COMMANDS = ["wc.input", "native.click", "native.key", "native.drag", "login.input"];

export function workerUsesInputBaseCommand(source) {
  return INPUT_BASE_COMMANDS.some(command => source.includes(`"${command}"`) || source.includes(`'${command}'`));
}
