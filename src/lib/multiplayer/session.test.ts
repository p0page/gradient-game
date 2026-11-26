import { afterEach, describe, expect, test, vi } from 'vitest';
import { demoRules, type DemoAction, type DemoState } from '../demo/rules';
import { MatchSession } from './session';
import type { Journal, JournalStore, LinkStatus, MatchLink, MatchSeat } from './protocol';

const seat: MatchSeat = {
  matchId: 'a'.repeat(32),
  secret: 'b'.repeat(32),
  player: 0,
  gameId: demoRules.gameId,
  rulesVersion: demoRules.version,
};

function memoryStore(): JournalStore {
  let saved: Journal | undefined;
  return {
    get: async (id) => saved?.matchId === id ? structuredClone(saved) : undefined,
    save: async (_previous, next) => { saved = structuredClone(next); },
  };
}

class TestLink implements MatchLink {
  status: LinkStatus = 'open';
  peer!: TestLink;
  statuses = new Set<(status: LinkStatus) => void>();
  messages = new Set<(message: string) => void>();
  filter = (message: string) => [message];

  send(message: string): void {
    for (const delivered of this.filter(message)) {
      queueMicrotask(() => {
        if (this.status !== 'open' || this.peer.status !== 'open') return;
        for (const listener of this.peer.messages) listener(delivered);
      });
    }
  }

  onMessage(listener: (message: string) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onStatus(listener: (status: LinkStatus) => void): () => void {
    this.statuses.add(listener);
    return () => this.statuses.delete(listener);
  }

  close(): void {
    if (this.status === 'closed') return;
    this.status = 'closed';
    for (const listener of this.statuses) listener('closed');
    this.peer.close();
  }
}

type Session = MatchSession<DemoState, DemoAction>;
const opened: Session[] = [];

async function open(player: 0 | 1, store: JournalStore, rules = demoRules): Promise<Session> {
  const session = await MatchSession.open({ ...seat, player }, rules, store);
  opened.push(session);
  return session;
}

function connect(left: Session, right: Session): [TestLink, TestLink] {
  const leftLink = new TestLink();
  const rightLink = new TestLink();
  leftLink.peer = rightLink;
  rightLink.peer = leftLink;
  left.connect(leftLink);
  right.connect(rightLink);
  return [leftLink, rightLink];
}

async function expectReady(left: Session, right: Session, revision: number, total: number) {
  await vi.waitFor(() => {
    expect(left.view).toMatchObject({ phase: 'ready', pending: false, revision, state: { total } });
    expect(right.view).toMatchObject({ phase: 'ready', pending: false, revision, state: { total } });
    expect(left.view.digest).toBe(right.view.digest);
  }, { interval: 5 });
}

afterEach(() => {
  for (const session of opened.splice(0)) session.disconnect();
});

describe('peer match synchronization', () => {
  test('validates the acting seat and applies duplicate commands and ACKs only once', async () => {
    const left = await open(0, memoryStore());
    const right = await open(1, memoryStore());
    const links = connect(left, right);
    await expectReady(left, right, 0, 0);
    for (const link of links) link.filter = (raw) => [raw, raw];
    await expect(right.submit({ add: 2 })).rejects.toThrow('当前无法提交');
    await expect(left.submit({ add: 4 } as unknown as DemoAction)).rejects.toThrow('操作无效');
    await left.submit({ add: 3 });
    await expectReady(left, right, 1, 3);
    await right.submit({ add: 2 });
    await expectReady(left, right, 2, 5);
  });

  test('retries an undelivered command after both browsers reload', async () => {
    const leftStore = memoryStore();
    const rightStore = memoryStore();
    const left = await open(0, leftStore);
    const right = await open(1, rightStore);
    const [leftLink] = connect(left, right);
    await expectReady(left, right, 0, 0);
    leftLink.filter = () => [];
    await left.submit({ add: 3 });
    expect(left.view).toMatchObject({ pending: true, revision: 0 });
    leftLink.close();

    const reloadedLeft = await open(0, leftStore);
    const reloadedRight = await open(1, rightStore);
    connect(reloadedLeft, reloadedRight);
    await expectReady(reloadedLeft, reloadedRight, 1, 3);
    expect(reloadedRight.view.canSubmit).toBe(true);
  });

  test('recovers a lost ACK and a pending reply without applying either move twice', async () => {
    const leftStore = memoryStore();
    const rightStore = memoryStore();
    const left = await open(0, leftStore);
    const right = await open(1, rightStore);
    const [, rightLink] = connect(left, right);
    await expectReady(left, right, 0, 0);
    rightLink.filter = () => [];
    await left.submit({ add: 3 });
    await vi.waitFor(() => expect(right.view.revision).toBe(1), { interval: 5 });
    await right.submit({ add: 2 });
    expect(right.view).toMatchObject({ pending: true, revision: 1 });
    expect(left.view).toMatchObject({ pending: true, revision: 0 });
    rightLink.close();

    const reloadedLeft = await open(0, leftStore);
    const reloadedRight = await open(1, rightStore);
    connect(reloadedLeft, reloadedRight);
    await expectReady(reloadedLeft, reloadedRight, 2, 5);
    expect(reloadedLeft.view.canSubmit).toBe(true);
  });

  test('refuses a mismatched rules version before accepting any actions', async () => {
    await expect(open(0, memoryStore(), { ...demoRules, version: 2 })).rejects.toThrow('规则版本');
    const left = await open(0, memoryStore());
    const right = await open(1, memoryStore());
    const [leftLink] = connect(left, right);
    leftLink.filter = (raw) => {
      const frame = JSON.parse(raw);
      return [JSON.stringify({ ...frame, rulesVersion: 2 })];
    };
    await vi.waitFor(() => expect(right.view.error).toContain('规则版本'), { interval: 5 });
    expect(right.view.canSubmit).toBe(false);
  });

  test('stops if comparable revisions have different log digests', async () => {
    const left = await open(0, memoryStore());
    const right = await open(1, memoryStore());
    const [leftLink] = connect(left, right);
    leftLink.filter = (raw) => [JSON.stringify({ ...JSON.parse(raw), digest: '0'.repeat(64) })];
    await vi.waitFor(() => {
      expect(right.view).toMatchObject({ phase: 'error', canSubmit: false, revision: 0 });
      expect(right.view.error).toContain('对局记录不一致');
    }, { interval: 5 });
  });

  test('halts if two reducers derive different results from the same action', async () => {
    const left = await open(0, memoryStore());
    const right = await open(1, memoryStore(), {
      ...demoRules,
      apply: (state, player) => demoRules.apply(state, player, { add: 1 }),
    });
    connect(left, right);
    await expectReady(left, right, 0, 0);
    await left.submit({ add: 3 });
    await vi.waitFor(() => {
      expect(left.view).toMatchObject({ phase: 'error', pending: true, revision: 0, canSubmit: false });
      expect(left.view.error).toContain('状态不一致');
    }, { interval: 5 });
  });

  test('does not ACK an action that the receiving browser failed to store', async () => {
    const left = await open(0, memoryStore());
    const store = memoryStore();
    const right = await open(1, {
      ...store,
      save: async (previous, next) => {
        if (next.entries.length) throw new Error('本地存储不可用');
        await store.save(previous, next);
      },
    });
    connect(left, right);
    await expectReady(left, right, 0, 0);
    await left.submit({ add: 3 });
    await vi.waitFor(() => {
      expect(right.view.error).toContain('本地存储');
      expect(left.view).toMatchObject({ phase: 'offline', pending: true, revision: 0 });
    }, { interval: 5 });
  });
});
