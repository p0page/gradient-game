<script lang="ts">
  import { onMount } from 'svelte';
  import BrandTitle from './components/BrandTitle.svelte';
  import MatchBoard from './components/MatchBoard.svelte';
  import { demoRules, type DemoAction, type DemoState } from './lib/demo/rules';
  import {
    createIndexedMatchStore, MatchSession, parseInvitation, randomId, WebRtcLink,
    type Journal, type MatchSeat, type MatchView,
  } from './lib/multiplayer';

  const store = createIndexedMatchStore('gradient-game-multiplayer');
  const game = { gameId: demoRules.gameId, rulesVersion: demoRules.version };
  let match = $state.raw<MatchView<DemoState> | null>(null);
  let saved = $state.raw<Journal[]>([]);
  let session: MatchSession<DemoState, DemoAction> | null = null;
  let unsubscribe: (() => void) | undefined;
  let applyAnswer: ((code: string) => Promise<void>) | undefined;
  let pairing = $state<'idle' | 'offer' | 'answer' | 'waiting'>('idle');
  let input = $state('');
  let output = $state('');
  let busy = $state(false);
  let error = $state('');
  let copyNotice = $state('');
  let supported = $state(true);
  let outputBox: HTMLTextAreaElement | undefined = $state();

  const connected = $derived(match?.phase === 'ready' || match?.phase === 'syncing');
  const needsPairing = $derived(!connected && pairing !== 'waiting' && pairing !== 'answer');
  const status = $derived.by(() => {
    if (match?.phase === 'ready') return '已直连';
    if (match?.phase === 'syncing') return '校验对局中';
    if (match?.phase === 'error') return '同步异常';
    if (busy || pairing !== 'idle') return '配对中';
    if (match) return '连接已断开';
    return '未连接';
  });

  onMount(() => {
    supported = window.isSecureContext && typeof RTCPeerConnection !== 'undefined'
      && typeof indexedDB !== 'undefined' && !!crypto.subtle;
    if (supported) void refreshSaved();
    return () => stop();
  });

  async function refreshSaved() {
    try {
      saved = (await store.list()).filter((item) =>
        item.gameId === game.gameId && item.rulesVersion === game.rulesVersion,
      ).sort((left, right) => right.updatedAt - left.updatedAt);
    } catch (cause) {
      error = errorText(cause);
    }
  }

  function stop() {
    unsubscribe?.();
    unsubscribe = undefined;
    session?.disconnect();
    session = null;
  }

  function reset() {
    stop();
    applyAnswer = undefined;
    pairing = 'idle';
    match = null;
    input = '';
    output = '';
    copyNotice = '';
    error = '';
    void refreshSaved();
  }

  function attach(current: MatchSession<DemoState, DemoAction>, link: WebRtcLink) {
    stop();
    session = current;
    unsubscribe = session.subscribe((next) => {
      const previous = match?.phase;
      match = next;
      if (next.phase === 'ready' && previous !== 'ready') {
        pairing = 'idle';
        output = '';
        input = '';
        applyAnswer = undefined;
      } else if ((next.phase === 'offline' || next.phase === 'error') && previous
        && previous !== 'offline' && previous !== 'error') {
        pairing = 'idle';
        output = '';
        input = '';
        applyAnswer = undefined;
        if (!next.error) error = previous === 'connecting'
          ? '配对未完成。请确认双方在同一 Wi-Fi、设备可互通，然后重新生成邀请。'
          : '连接已中断。请重新配对来继续对局。';
        void refreshSaved();
      }
    });
    session.connect(link);
  }

  async function invite(resume?: MatchSeat) {
    if (busy || !supported) return;
    reset();
    busy = true;
    let link: WebRtcLink | undefined;
    try {
      const current = await MatchSession.open(resume ?? {
        ...game, matchId: randomId(), secret: randomId(), player: 0,
      }, demoRules, store);
      link = new WebRtcLink();
      attach(current, link);
      const invitation = await link.offer(current.seat);
      applyAnswer = invitation.accept;
      output = invitation.code;
      pairing = 'offer';
    } catch (cause) {
      link?.close();
      error = errorText(cause);
    } finally {
      busy = false;
    }
  }

  async function useCode(event: SubmitEvent) {
    event.preventDefault();
    if (!input.trim() || busy || !supported) return;
    error = '';
    copyNotice = '';
    busy = true;
    let link: WebRtcLink | undefined;
    try {
      if (pairing === 'offer' && applyAnswer) {
        await applyAnswer(input);
        if (match?.phase === 'connecting') pairing = 'waiting';
      } else {
        const invitation = parseInvitation(input);
        const { seat } = invitation;
        const current = await MatchSession.open({
          ...seat, player: seat.player === 0 ? 1 : 0,
        }, demoRules, store);
        link = new WebRtcLink();
        attach(current, link);
        const answer = await link.answer(invitation);
        if (!connected) {
          output = answer;
          pairing = 'answer';
        }
      }
      input = '';
    } catch (cause) {
      link?.close();
      error = errorText(cause);
    } finally {
      busy = false;
    }
  }

  async function copyCode() {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      copyNotice = '已复制';
    } catch {
      outputBox?.focus();
      outputBox?.select();
      copyNotice = '配对码已选中，请手动复制';
    }
  }

  async function submit(action: DemoAction) {
    error = '';
    try {
      await session?.submit(action);
    } catch (cause) {
      error = errorText(cause);
    }
  }

  function disconnect() {
    session?.disconnect();
    error = '';
    applyAnswer = undefined;
    output = '';
    input = '';
    pairing = 'idle';
    void refreshSaved();
  }

  function errorText(cause: unknown): string {
    return cause instanceof Error && cause.message ? cause.message : '操作失败，请重试。';
  }

  function savedTime(value: number): string {
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(value);
  }
</script>

<main class="shell">
  <header class="topbar">
    <BrandTitle />
    <span class="status" class:live={match?.phase === 'ready'} role="status">{status}</span>
  </header>

  <div class="intro">
    <h1>局域网对战</h1>
    <p>两台设备打开此页，连到同一个 Wi-Fi，交换邀请和回应。</p>
  </div>

  <div class="workspace">
    <section class="card connection" aria-labelledby="connection-title">
      <header class="connection-header">
        <h2 id="connection-title">{connected ? '对局连接' : '邀请对手'}</h2>
        {#if connected}
          <button type="button" class="btn btn-ghost" onclick={disconnect}>断开</button>
        {:else if pairing !== 'idle'}
          <button type="button" class="btn btn-ghost" onclick={reset} disabled={busy}>取消</button>
        {/if}
      </header>

      {#if !supported}
        <p class="error" role="alert">需要支持 WebRTC 和本地存储的浏览器。请通过 HTTPS 或 localhost 打开页面。</p>
      {:else if connected}
        <div class="connection-note">
          <strong>{match?.phase === 'syncing' ? '正在核对对局记录' : '两台设备已连接'}</strong>
          <span>你是玩家 {(match?.player ?? 0) + 1}。断开后可重新配对并继续。</span>
        </div>
      {:else}
        {#if pairing === 'idle'}
          <button type="button" class="btn btn-primary create" disabled={busy} onclick={() => invite()}>
            {busy ? '处理中…' : '生成新邀请'}
          </button>
        {/if}

        {#if output}
          <div class="code-group">
            <label for="output">{pairing === 'offer' ? '发给对手的邀请' : '发回给对手的回应'}</label>
            <textarea id="output" class="code" rows="3" readonly value={output} bind:this={outputBox} spellcheck="false"></textarea>
            <div class="copy-row">
              <button type="button" class="btn btn-ghost" onclick={copyCode}>复制配对码</button>
              <span role="status">{copyNotice}</span>
            </div>
          </div>
        {/if}

        {#if needsPairing}
          <form class="code-group" onsubmit={useCode}>
            <label for="input">{pairing === 'offer' ? '粘贴对方的回应' : '收到对方的邀请？'}</label>
            <textarea id="input" class="code" rows="3" maxlength="33000" bind:value={input}
              placeholder={pairing === 'offer' ? '在此粘贴回应' : '在此粘贴邀请'}
              autocapitalize="off" spellcheck="false"></textarea>
            <button type="submit" class="btn btn-ghost" disabled={!input.trim() || busy}>
              {pairing === 'offer' ? '建立连接' : '生成回应'}
            </button>
          </form>
        {:else}
          <p class="waiting" role="status">{pairing === 'answer' ? '等对方粘贴回应后，连接会自动建立。' : '正在连接对手…'}</p>
        {/if}

        {#if pairing === 'idle' && saved.length}
          <div class="saved">
            <h3>继续对局</h3>
            {#each saved as item (item.matchId)}
              <button type="button" class="resume" onclick={() => invite(item)} disabled={busy}>
                <span><strong>玩家 {item.player + 1}</strong><small>{savedTime(item.updatedAt)}</small></span>
                <span class="tabular">{item.entries.length} 步{item.pending ? ' · 待确认' : ''}</span>
              </button>
            {/each}
          </div>
        {/if}
      {/if}

      {#if error || match?.error}
        <p class="error" role="alert">{match?.error ?? error}</p>
      {/if}
    </section>

    <MatchBoard {match} {submit} />
  </div>
</main>

<style>
  .shell {
    width: min(100%, 980px); margin: 0 auto;
    padding: 26px clamp(14px, 4vw, 36px) max(32px, env(safe-area-inset-bottom));
  }
  .topbar, .connection-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .topbar { padding-bottom: 18px; border-bottom: 1px solid var(--border-strong); }
  .status {
    display: inline-flex; align-items: center; gap: 7px; border-radius: var(--radius-pill);
    background: var(--bg-surface); padding: 7px 11px; font-size: .75rem; font-weight: 650;
    color: var(--text-secondary); border: 1px solid var(--border-subtle);
  }
  .status::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .status.live { color: #14623c; background: #ecf8f0; }
  .intro { padding: 29px 0 22px; }
  h1 { font-size: clamp(2rem, 5.5vw, 3.1rem); margin: 0; letter-spacing: -.055em; line-height: 1.15; }
  .intro p { margin: 8px 0 0; color: var(--text-secondary); font-size: .92rem; line-height: 1.65; }
  .workspace { display: grid; grid-template-columns: minmax(270px, 0.9fr) minmax(0, 1.3fr); gap: 16px; align-items: start; }
  .connection { display: grid; gap: 16px; }
  .connection-note { display: grid; gap: 7px; background: var(--bg-elevated); border-radius: var(--radius-sm); padding: 14px; }
  .connection-note span, .waiting, .copy-row span { color: var(--text-secondary); font-size: .8rem; line-height: 1.55; }
  .create { justify-self: start; min-height: 44px; }
  .code-group { display: grid; gap: 8px; }
  .code-group label { font-size: .84rem; font-weight: 650; }
  .code-group button { justify-self: start; }
  .code {
    width: 100%; min-height: 72px; resize: vertical; padding: 10px 12px;
    border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
    background: var(--bg-elevated); color: var(--text-primary);
    font: .82rem/1.55 ui-monospace, monospace; overflow-wrap: anywhere;
  }
  .code:focus-visible { outline: 2px solid var(--player-p1-ink); outline-offset: 2px; }
  .code::placeholder { font: inherit; color: var(--text-muted); }
  .copy-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .saved { display: grid; gap: 7px; padding-top: 13px; border-top: 1px solid var(--border-subtle); }
  .saved h3 { margin: 0 0 2px; font-size: .85rem; }
  .resume {
    display: flex; align-items: center; justify-content: space-between; gap: 9px;
    background: var(--bg-elevated); border-radius: var(--radius-sm); padding: 10px;
    text-align: start; font-size: .78rem;
  }
  .resume:hover:not(:disabled) { background: var(--bg-subtle); }
  .resume strong { margin-right: 8px; }
  .resume small, .resume > :last-child { color: var(--text-secondary); font-size: .75rem; }
  .error {
    background: #fff1f2; color: #9f1239; border: 1px solid #ffe4e6;
    border-radius: var(--radius-sm); padding: 10px 12px; font-size: .8rem; line-height: 1.55;
  }
  .error, .waiting { margin: 0; }
  @media (max-width: 700px) {
    .workspace { grid-template-columns: minmax(0, 1fr); }
    .intro { padding: 22px 0 17px; }
    .shell { padding-top: max(16px, env(safe-area-inset-top)); }
  }
</style>
