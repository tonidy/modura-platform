/**
 * A command-line calculator on a Modura contract.
 *
 *   pnpm calc 7 / 2                 7 / 2 = 3 remainder 1
 *   pnpm calc 6 x 7 --store answer  stores 42 in the slot `answer`
 *   pnpm calc recall answer
 *   pnpm calc tape
 *
 * Operators: + - x / (x rather than *, which the shell would expand). Memory and the
 * tape are kept in CALC_STATE, default .calculator-state.json in the working directory.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { ModuraError } from '@modura/sdk';
import { type CalculatorOperator, type CalculatorResult, createModuraClient } from './generated/client.ts';
import { createLocalTransport, emptyState, type State } from './local.ts';

const usage = `Usage:
  calc <left> <+ | - | x | /> <right> [--store <slot>]
  calc recall <slot>
  calc tape`;

const operators: Record<string, CalculatorOperator> = { '+': 'add', '-': 'subtract', x: 'multiply', '/': 'divide' };
const symbols: Record<CalculatorOperator, string> = { add: '+', subtract: '-', multiply: 'x', divide: '/' };

const statePath = process.env.CALC_STATE ?? '.calculator-state.json';
const state = load();
const client = createModuraClient(createLocalTransport(state));

async function main(args: string[]): Promise<number> {
  if (args[0] === 'recall' && args.length === 2) {
    const recalled = await client.calculator.recall({ slot: args[1]! });
    if (!recalled.ok) return fail(recalled.error);
    console.log(`${recalled.value.slot} = ${format(recalled.value.result)}`);
    return 0;
  }

  if (args[0] === 'tape' && args.length === 1) {
    const listed = await client.tape.list({});
    if (!listed.ok) return fail(listed.error);
    if (listed.value.entries.length === 0) console.log('The tape is empty.');
    for (const entry of listed.value.entries) console.log(`${entry.storedAt}  ${entry.slot} = ${entry.value}`);
    return 0;
  }

  const [left, symbol, right, flag, slot] = args;
  const operator = symbol === undefined ? undefined : operators[symbol];
  if (operator === undefined || !isInteger(left) || !isInteger(right) || (flag !== undefined && (flag !== '--store' || slot === undefined))) {
    console.error(usage);
    return 2;
  }

  const evaluated = await client.calculator.evaluate({ left: Number(left), operator, right: Number(right) });
  if (!evaluated.ok) return fail(evaluated.error);
  console.log(`${left} ${symbols[operator]} ${right} = ${format(evaluated.value)}`);

  if (slot !== undefined) {
    // One key per attempt: retrying this exact store would replay it (ADR-0004 in modura-pos).
    const stored = await client.calculator.store({ slot, result: evaluated.value }, { idempotencyKey: randomUUID() });
    if (!stored.ok) return fail(stored.error);
    save();
    console.log(`Stored in ${slot}.`);
  }
  return 0;
}

function format(result: CalculatorResult): string {
  return result.remainder === undefined || result.remainder === 0
    ? String(result.value)
    : `${result.value} remainder ${result.remainder}`;
}

function isInteger(text: string | undefined): text is string {
  return text !== undefined && /^-?\d+$/.test(text);
}

function fail(error: ModuraError): number {
  console.error(`${error.code}: ${error.message}`);
  return 1;
}

function load(): State {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as State;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }
}

function save(): void {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

process.exitCode = await main(process.argv.slice(2));
