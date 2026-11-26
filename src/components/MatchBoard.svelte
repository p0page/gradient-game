<script lang="ts">
  import type { MatchView } from '../lib/multiplayer';
  import { TARGET, type DemoAction, type DemoState } from '../lib/demo/rules';

  let { match, submit }: {
    match: MatchView<DemoState> | null;
    submit: (action: DemoAction) => void;
  } = $props();

  const additions = [1, 2, 3] as const;
  const values = Array.from({ length: TARGET }, (_, index) => index + 1);
  const total = $derived(match?.state.total ?? 0);
  const winner = $derived(match?.state.winner ?? null);
  const instruction = $derived.by(() => {
    if (winner !== null) return winner === match?.player ? '你赢了' : '对手获胜';
    if (match?.pending) return '等待对方确认';
    if (match?.phase !== 'ready') return '连接后开始';
    return match.canSubmit ? '轮到你了' : '等待对方操作';
  });
</script>

<section class="board card" aria-labelledby="board-title">
  <header class="board-header">
    <div>
      <h2 id="board-title">凑到 15</h2>
      <p>联机测试用。轮流加 1、2 或 3，刚好到 15 的人获胜。</p>
    </div>
    <span class="revision tabular">已同步 {match?.revision ?? 0} 步</span>
  </header>

  <div class="players">
    {#each [0, 1] as player}
      <div class="player" class:blue={player === 1}
        class:active={match?.nextPlayer === player && match?.phase === 'ready'}>
        <span class="dot"></span>
        <span>玩家 {player + 1}</span>
        {#if match?.player === player}<strong>你</strong>{/if}
      </div>
    {/each}
  </div>

  <div class="track" class:blue={match?.lastCommand?.from === 1} aria-label="当前总数 {total}，目标 {TARGET}">
    {#each values as value}
      <span class:filled={value <= total} class:current={value === total}>{value}</span>
    {/each}
  </div>

  <div class="action-row">
    <div class="turn" aria-live="polite">
      <strong>{instruction}</strong>
      <span>当前总数 <b class="tabular">{total}</b></span>
    </div>
    <div class="actions" aria-label="增加点数">
      {#each additions as add}
        <button type="button" class="btn btn-primary tabular"
          disabled={!match?.canSubmit || total + add > TARGET}
          onclick={() => submit({ add })} aria-label="增加 {add} 点">+{add}</button>
      {/each}
    </div>
  </div>
</section>

<style>
  .board { display: grid; align-content: start; gap: 22px; }
  .board-header, .action-row { display: flex; justify-content: space-between; gap: 14px; align-items: start; }
  .board-header h2 { font-size: clamp(1.3rem, 3vw, 1.65rem); }
  .revision {
    padding: 6px 10px; border-radius: var(--radius-pill); background: var(--bg-subtle);
    color: var(--text-secondary); white-space: nowrap; font-size: .75rem; font-weight: 650;
  }
  .players { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .player {
    --player: var(--accent-p0); --tint: var(--player-p0-tint); --player-ink: var(--player-p0-ink);
    display: flex; align-items: center; gap: 8px; padding: 11px 12px; border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle); font-size: .875rem; white-space: nowrap;
  }
  .player.blue { --player: var(--accent-p1); --tint: var(--player-p1-tint); --player-ink: var(--player-p1-ink); }
  .player.active { background: var(--tint); border-color: color-mix(in srgb, var(--player) 25%, transparent); }
  .dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--player); }
  .player strong { margin-left: auto; color: var(--player-ink); font-size: .73rem; }
  .track {
    --fill: var(--player-p0-tint); --fill-text: var(--player-p0-ink);
    display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px;
    background: var(--bg-elevated); border-radius: var(--radius-md); padding: 10px;
  }
  .track.blue { --fill: var(--player-p1-tint); --fill-text: var(--player-p1-ink); }
  .track span {
    aspect-ratio: 1.45; display: grid; place-items: center; border-radius: 9px; background: var(--bg-cell);
    color: var(--text-secondary); font-size: clamp(.8rem, 2.5vw, 1.05rem); font-weight: 700;
    border: 1px solid var(--border-subtle); font-variant-numeric: tabular-nums;
  }
  .track .filled { background: var(--fill); color: var(--fill-text); }
  .track .current { background: var(--fill-text); color: white; }
  .action-row { align-items: center; }
  .turn { display: grid; gap: 4px; min-width: 0; }
  .turn span { color: var(--text-secondary); font-size: .8rem; }
  .actions { display: flex; gap: 6px; }
  .actions button { min-width: 43px; min-height: 44px; padding-inline: 10px; }
  @media (max-width: 420px) {
    .board-header { flex-wrap: wrap; }
    .board { gap: 16px; }
  }
</style>
