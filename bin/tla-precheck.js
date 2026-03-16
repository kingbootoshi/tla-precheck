#!/usr/bin/env node
import { main } from "../dist/cli/machine.js";

const reportCliError = (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
};

await main().catch(reportCliError);
