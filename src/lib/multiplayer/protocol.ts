export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Player = 0 | 1;
export const PROTOCOL_VERSION = 1;

export interface MatchIdentity {
  matchId: string;
  gameId: string;
  rulesVersion: number;
}

export interface MatchSeat extends MatchIdentity {
  player: Player;
  secret: string;
}

export interface Command<Action extends Json = Json> {
  id: string;
  from: Player;
  base: number;
  action: Action;
}

export interface Entry<Action extends Json = Json> {
  command: Command<Action>;
  digest: string;
}

export interface Journal extends MatchSeat {
  genesis: string;
  entries: Entry[];
  pending: Command | null;
  updatedAt: number;
}

/** Rules operate on shared information. Hidden data belongs to the caller. */
export interface MatchRules<State extends Json, Action extends Json> {
  gameId: string;
  version: number;
  initialState: () => State;
  nextPlayer: (state: State) => Player | null;
  isAction: (action: Json) => action is Action;
  /** Deterministic. Return null when the move is illegal. Do not mutate state. */
  apply: (state: Readonly<State>, player: Player, action: Action) => State | null;
}

export interface JournalStore {
  get: (matchId: string) => Promise<Journal | undefined>;
  /** Atomically replace the exact previously read revision and pending command. */
  save: (previous: Journal | undefined, next: Journal) => Promise<void>;
}

export type LinkStatus = 'connecting' | 'open' | 'closed';

export interface MatchLink {
  readonly status: LinkStatus;
  send: (message: string) => void;
  onMessage: (listener: (message: string) => void) => () => void;
  onStatus: (listener: (status: LinkStatus) => void) => () => void;
  close: () => void;
}

export const MAX_FRAME_BYTES = 12 * 1024;
const encoder = new TextEncoder();

export function messageBytes(message: string): number {
  return encoder.encode(message).byteLength;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function isPlayer(value: unknown): value is Player {
  return value === 0 || value === 1;
}

export function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isGameId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

export function isJson(value: unknown, depth = 0): value is Json {
  if (depth > 32) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (Array.isArray(value)) return Array.from(value).every((item) => isJson(item, depth + 1));
  if (!isObject(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every((item) => isJson(item, depth + 1));
}

export function isCommand(value: unknown): value is Command {
  return isObject(value) && Object.keys(value).length === 4 && isId(value.id)
    && isPlayer(value.from) && isRevision(value.base) && isJson(value.action);
}

export function randomId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return '{' + Object.keys(value).sort().map(
    (key) => JSON.stringify(key) + ':' + canonicalJson(value[key]),
  ).join(',') + '}';
}

export async function digestOf(value: Json): Promise<string> {
  if (!crypto.subtle) throw new Error('联机需要 HTTPS 页面或 localhost。');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalJson(value)));
  return toHex(new Uint8Array(digest));
}

export function commandJson(command: Command): Json {
  return {
    id: command.id,
    from: command.from,
    base: command.base,
    action: command.action,
  };
}
