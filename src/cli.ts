#!/usr/bin/env node
import { runCli } from "./main.ts";

/** All of stdin as UTF-8 text. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

void runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  stdin: readStdin,
  cwd: process.cwd(),
}).then((code) => {
  process.exitCode = code;
});
