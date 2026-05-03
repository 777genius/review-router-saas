#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import dotenv from "dotenv";

if (existsSync(".env.local"))
  dotenv.config({ path: ".env.local", override: false });
if (existsSync(".env")) dotenv.config({ path: ".env", override: false });

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: node scripts/run-with-env.mjs <command> [...args]");
  process.exit(1);
}

const child = spawn(command, args, {
  stdio: "inherit",
  shell: false,
  env: process.env,
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Command terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
