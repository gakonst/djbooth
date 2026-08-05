import { Cli, z } from "incur";

import { stopManagedDjBoothServer } from "./runtime.js";

export const stopCli = Cli.create("stop", {
  description: "Stop the managed djbooth workstation/API and its owned Pro DJ Link runtime.",
  output: z.object({
    stopped: z.boolean(),
    wasRunning: z.boolean(),
    pid: z.number().int().positive().optional(),
  }),
  async run() {
    return stopManagedDjBoothServer();
  },
});
