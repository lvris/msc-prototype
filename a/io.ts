/**
 * io.ts — a single shared readline for the CLI (choosing + filling fields).
 */

import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";

let rl: readline.Interface | null = null;

function iface(): readline.Interface {
  if (!rl) rl = readline.createInterface({ input, output });
  return rl;
}

export const ask = (question: string): Promise<string> => iface().question(question);

export function closeIo(): void {
  rl?.close();
  rl = null;
}
