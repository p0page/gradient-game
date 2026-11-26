import {
  canonicalJson, commandJson, digestOf, isCommand, isDigest, isId, isJson, isObject,
  isPlayer, isRevision, MAX_FRAME_BYTES, messageBytes, PROTOCOL_VERSION, randomId,
  type Command, type Entry, type Journal, type JournalStore, type Json,
  type MatchLink, type MatchRules, type MatchSeat, type Player,
} from './protocol';

const CONFIRM_TIMEOUT = 12_000;
const MAX_ENTRIES = 1_000;

export type SessionPhase = 'offline' | 'connecting' | 'syncing' | 'ready' | 'error';

export interface MatchView<State extends Json> {
  phase: SessionPhase;
  state: State;
  player: Player;
  nextPlayer: Player | null;
  revision: number;
  digest: string;
  pending: boolean;
  canSubmit: boolean;
  error: string | null;
  lastCommand: Command | null;
}

interface Binding {
  link: MatchLink;
  unsubscribe: () => void;
  helloReceived: boolean;
  waitingForReplay?: string;
}

export class MatchSession<State extends Json, Action extends Json> {
  #journal: Journal;
  #state: State;
  #rules: MatchRules<State, Action>;
  #store: JournalStore;
  #phase: SessionPhase = 'offline';
  #error: string | null = null;
  #binding: Binding | undefined;
  #task: Promise<void> = Promise.resolve();
  #watchdog: ReturnType<typeof setTimeout> | undefined;
  #listeners = new Set<(view: MatchView<State>) => void>();

  private constructor(
    journal: Journal, state: State, rules: MatchRules<State, Action>, store: JournalStore,
  ) {
    this.#journal = journal;
    this.#state = state;
    this.#rules = rules;
    this.#store = store;
  }

  static async open<State extends Json, Action extends Json>(
    seat: MatchSeat, rules: MatchRules<State, Action>, store: JournalStore,
  ): Promise<MatchSession<State, Action>> {
    if (!isId(seat.matchId) || !isId(seat.secret) || !isPlayer(seat.player)
      || seat.gameId !== rules.gameId || seat.rulesVersion !== rules.version) {
      throw new Error('游戏或规则版本不一致。');
    }
    const saved = await store.get(seat.matchId);
    const state = rules.initialState();
    if (!isJson(state)) throw new Error('游戏初始状态必须是有效的 JSON。');
    const genesis = await digestOf({
      matchId: seat.matchId, gameId: seat.gameId, rulesVersion: seat.rulesVersion, state,
    });
    if (saved && (saved.genesis !== genesis || saved.secret !== seat.secret || saved.player !== seat.player
      || saved.gameId !== seat.gameId || saved.rulesVersion !== seat.rulesVersion)) {
      throw new Error('这份邀请和此浏览器保存的对局或玩家席位不一致。');
    }

    const journal = saved ?? { ...seat, genesis, entries: [], pending: null, updatedAt: Date.now() };
    const session = new MatchSession(journal, state, rules, store);
    if (saved) await session.#restore();
    else await store.save(undefined, journal);
    return session;
  }

  get seat(): MatchSeat {
    const { matchId, secret, player, gameId, rulesVersion } = this.#journal;
    return { matchId, secret, player, gameId, rulesVersion };
  }

  get view(): MatchView<State> {
    const { player, pending, entries } = this.#journal;
    const nextPlayer = this.#rules.nextPlayer(this.#state);
    return {
      phase: this.#phase,
      state: structuredClone(this.#state),
      player,
      nextPlayer,
      revision: entries.length,
      digest: this.#head,
      pending: pending !== null,
      canSubmit: this.#phase === 'ready' && this.#binding?.link.status === 'open'
        && !pending && nextPlayer === player,
      error: this.#error,
      lastCommand: structuredClone(entries.at(-1)?.command ?? null),
    };
  }

  subscribe(listener: (view: MatchView<State>) => void): () => void {
    this.#listeners.add(listener);
    listener(this.view);
    return () => this.#listeners.delete(listener);
  }

  connect(link: MatchLink): void {
    this.disconnect();
    this.#error = null;
    this.#phase = 'connecting';

    const attached: Binding = { link, helloReceived: false, unsubscribe: () => {} };
    this.#binding = attached;
    const onStatus = (status: MatchLink['status']) => {
      if (this.#binding !== attached) return;
      if (status === 'closed') this.disconnect();
      if (status === 'open') {
        void this.#enqueueNetwork(attached, async () => {
          this.#phase = 'syncing';
          this.#publish();
          this.#watch(attached);
          this.#send(attached, {
            type: 'hello', revision: this.#journal.entries.length, digest: this.#head,
            pendingId: this.#journal.pending?.id ?? null, from: this.#journal.player,
            gameId: this.#journal.gameId, rulesVersion: this.#journal.rulesVersion,
          });
        });
      }
    };
    const unstatus = link.onStatus(onStatus);
    const unmessage = link.onMessage((raw) => {
      void this.#enqueueNetwork(attached, () => this.#receive(attached, raw));
    });
    attached.unsubscribe = () => { unstatus(); unmessage(); };
    onStatus(link.status);
    this.#publish();
  }

  disconnect(): void {
    this.#unbind();
    if (this.#phase !== 'error') this.#phase = 'offline';
    this.#publish();
  }

  submit(action: Action): Promise<void> {
    return this.#enqueue(async () => {
      const binding = this.#binding;
      const { player, entries, pending } = this.#journal;
      if (!binding || this.#phase !== 'ready' || binding.link.status !== 'open'
        || pending || this.#rules.nextPlayer(this.#state) !== player) {
        throw new Error('当前无法提交操作。');
      }
      if (!isJson(action) || !this.#rules.isAction(action)) throw new Error('操作无效。');
      const command: Command = {
        id: randomId(), from: player, base: entries.length, action: structuredClone(action),
      };
      if (messageBytes(this.#frame({ type: 'move', command: commandJson(command) })) > MAX_FRAME_BYTES) {
        throw new Error('操作内容过大。');
      }
      await this.#evaluate(command);
      try {
        await this.#save({ ...this.#journal, pending: command });
        this.#publish();
        this.#sendPending(binding);
      } catch (error) {
        this.#fail(error);
        throw error;
      }
    });
  }

  get #head(): string {
    return this.#journal.entries.at(-1)?.digest ?? this.#journal.genesis;
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.#task.then(operation);
    this.#task = task.catch(() => {});
    return task;
  }

  #enqueueNetwork(binding: Binding, operation: () => Promise<void>): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#binding !== binding) return;
      try {
        await operation();
      } catch (error) {
        if (this.#binding === binding) this.#fail(error);
      }
    });
  }

  async #receive(binding: Binding, raw: string): Promise<void> {
    if (messageBytes(raw) > MAX_FRAME_BYTES) throw new Error('收到过大的联机消息。');
    const message: unknown = JSON.parse(raw);
    if (!isObject(message) || message.version !== PROTOCOL_VERSION || message.matchId !== this.#journal.matchId) {
      throw new Error('对局或通信协议不匹配。');
    }
    if (message.type === 'hello') {
      await this.#receiveHello(binding, message);
      return;
    }
    if (!binding.helloReceived) throw new Error('收到未握手的联机消息。');
    if (message.type === 'move' && isCommand(message.command)) {
      await this.#receiveMove(binding, message.command);
      return;
    }
    if (message.type === 'ack' && isId(message.id) && isRevision(message.revision) && isDigest(message.digest)) {
      await this.#receiveAck(binding, message.id, message.revision, message.digest);
      return;
    }
    throw new Error('收到无法识别的联机消息。');
  }

  async #receiveHello(binding: Binding, message: Record<string, unknown>): Promise<void> {
    const { revision, digest, pendingId, from, gameId, rulesVersion } = message;
    if (binding.helloReceived || !isRevision(revision) || !isDigest(digest)
      || (pendingId !== null && !isId(pendingId)) || !isPlayer(from) || from === this.#journal.player
      || gameId !== this.#journal.gameId || rulesVersion !== this.#journal.rulesVersion) {
      throw new Error('对局席位、游戏或规则版本不一致。');
    }
    binding.helloReceived = true;
    const { entries, pending, genesis } = this.#journal;
    if (revision === entries.length && digest === this.#head) {
      if (pendingId && (pending || this.#rules.nextPlayer(this.#state) !== from)) {
        throw new Error('两端的待确认操作冲突。');
      }
      this.#ready(binding);
      this.#sendPending(binding);
      return;
    }

    // A sender cannot submit again until it sees the receiver's durable acknowledgement.
    // A recoverable gap therefore has one entry and a matching pending command.
    if (revision === entries.length + 1 && pending) {
      const recovered = await this.#evaluate(pending);
      if (recovered.entry.digest === digest
        && (pendingId === null || this.#rules.nextPlayer(recovered.state) === from)) {
        this.#sendPending(binding);
        return;
      }
    }
    const last = entries.at(-1);
    const previousDigest = entries.at(-2)?.digest ?? genesis;
    if (revision === entries.length - 1 && last && last.command.from === from
      && pendingId === last.command.id && digest === previousDigest) {
      binding.waitingForReplay = last.command.id;
      return;
    }
    throw new Error('两端的对局记录不一致，已暂停同步。');
  }

  async #receiveMove(binding: Binding, command: Command): Promise<void> {
    const { player, pending, entries } = this.#journal;
    if (command.from === player) throw new Error('操作来自错误的席位。');
    const existing = entries.find((entry) => entry.command.id === command.id);
    if (existing) {
      if (canonicalJson(commandJson(existing.command)) !== canonicalJson(commandJson(command))) {
        throw new Error('同一操作编号出现了不同内容。');
      }
      this.#ack(binding, existing);
      if (binding.waitingForReplay === command.id) {
        binding.waitingForReplay = undefined;
        this.#ready(binding);
        this.#sendPending(binding);
      }
      return;
    }
    if (this.#phase !== 'ready' || pending || command.base !== entries.length) {
      throw new Error('收到与当前进度冲突的操作。');
    }
    const { entry, state } = await this.#evaluate(command);
    await this.#record(entry, state);
    this.#ack(binding, entry);
  }

  async #receiveAck(binding: Binding, id: string, revision: number, digest: string): Promise<void> {
    const { pending, entries } = this.#journal;
    if (pending?.id !== id) {
      const old = entries[revision - 1];
      if (old?.command.id === id && old.command.from === this.#journal.player && old.digest === digest) return;
      throw new Error('收到与当前操作不匹配的确认。');
    }
    const { entry, state } = await this.#evaluate(pending);
    if (revision !== pending.base + 1 || digest !== entry.digest) {
      throw new Error('双方计算的状态不一致，已暂停同步。');
    }
    await this.#record(entry, state);
    this.#ready(binding);
  }

  #apply(state: State, command: Command): State | null {
    if (!this.#rules.isAction(command.action) || this.#rules.nextPlayer(state) !== command.from) return null;
    return this.#rules.apply(state, command.from, command.action);
  }

  async #evaluate(command: Command): Promise<{ entry: Entry; state: State }> {
    if (command.base >= MAX_ENTRIES) throw new Error('这场对局的记录已达到上限。');
    const state = this.#apply(this.#state, command);
    if (state === null || !isJson(state)) throw new Error('操作不符合规则或未产生有效状态。');
    const digest = await digestOf({
      previous: this.#head, command: commandJson(command), state,
    });
    return { entry: { command, digest }, state };
  }

  async #restore(): Promise<void> {
    const { entries, pending } = this.#journal;
    if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw new Error('本地对局记录无效。');
    const checked: Entry[] = [];
    this.#journal = { ...this.#journal, entries: checked };
    const ids = new Set<string>();
    for (const saved of entries) {
      const command = saved?.command;
      if (!isCommand(command) || command.base !== checked.length || ids.has(command.id)) {
        throw new Error('本地对局记录损坏。');
      }
      const { entry, state } = await this.#evaluate(command);
      if (saved.digest !== entry.digest) throw new Error('本地对局记录校验失败。');
      checked.push(entry);
      ids.add(command.id);
      this.#state = state;
    }
    if (pending !== null) {
      if (!isCommand(pending) || pending.base !== checked.length || pending.from !== this.#journal.player
        || ids.has(pending.id) || this.#apply(this.#state, pending) === null) {
        throw new Error('本地待确认操作无效。');
      }
    }
  }

  async #record(entry: Entry, state: State): Promise<void> {
    await this.#save({
      ...this.#journal, entries: [...this.#journal.entries, entry], pending: null,
    });
    this.#state = state;
    this.#publish();
  }

  async #save(next: Journal): Promise<void> {
    const updated = { ...next, updatedAt: Date.now() };
    await this.#store.save(this.#journal, updated);
    this.#journal = updated;
  }

  #frame(packet: Record<string, Json>): string {
    return JSON.stringify({ ...packet, version: PROTOCOL_VERSION, matchId: this.#journal.matchId });
  }

  #send(binding: Binding, packet: Record<string, Json>): void {
    if (this.#binding !== binding || binding.link.status !== 'open') return;
    try {
      binding.link.send(this.#frame(packet));
    } catch {
      this.disconnect();
    }
  }

  #ack(binding: Binding, entry: Entry): void {
    this.#send(binding, {
      type: 'ack', id: entry.command.id, revision: entry.command.base + 1, digest: entry.digest,
    });
  }

  #sendPending(binding: Binding): void {
    if (this.#binding !== binding || !this.#journal.pending) return;
    this.#watch(binding);
    this.#send(binding, { type: 'move', command: commandJson(this.#journal.pending) });
  }

  #ready(binding: Binding): void {
    if (this.#binding !== binding || binding.link.status !== 'open') return;
    clearTimeout(this.#watchdog);
    this.#phase = 'ready';
    this.#publish();
  }

  #watch(binding: Binding): void {
    clearTimeout(this.#watchdog);
    this.#watchdog = setTimeout(() => {
      if (this.#binding !== binding) return;
      this.#error = '等待对方确认超时，请重新配对。';
      this.disconnect();
    }, CONFIRM_TIMEOUT);
  }

  #fail(error: unknown): void {
    this.#error = error instanceof Error ? error.message : '同步失败。';
    this.#phase = 'error';
    this.disconnect();
  }

  #unbind(): void {
    clearTimeout(this.#watchdog);
    const binding = this.#binding;
    this.#binding = undefined;
    if (binding) {
      binding.unsubscribe();
      binding.link.close();
    }
  }

  #publish(): void {
    if (this.#listeners.size === 0) return;
    const view = this.view;
    for (const listener of this.#listeners) listener(view);
  }
}
