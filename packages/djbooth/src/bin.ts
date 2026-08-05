#!/usr/bin/env node

import { canDispatchDirectly, runDirectDjBoothCommand } from "./dispatch.js";
import { loadDjBoothEnvironment } from "./environment.js";

const argv = process.argv.slice(2);
loadDjBoothEnvironment();
if (canDispatchDirectly(argv)) await runDirectDjBoothCommand(argv);
else await (await import("./cli.js")).runDjBoothCli(argv, { environmentLoaded: true });
