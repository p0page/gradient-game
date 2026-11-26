import {
  isGameId, isId, isObject, isPlayer, isRevision, MAX_FRAME_BYTES, messageBytes,
  PROTOCOL_VERSION, randomId, type LinkStatus, type MatchLink, type MatchSeat,
} from './protocol';

const LABEL = 'turn-match-v1';
const PAIR_PREFIX = 'LAN1.';
const MAX_CODE_LENGTH = 32 * 1024;
const ICE_TIMEOUT = 12_000;
const CONNECTION_TIMEOUT = 90_000;

interface Pairing {
  version: typeof PROTOCOL_VERSION;
  connectionId: string;
  seat: MatchSeat;
  description: { type: 'offer' | 'answer'; sdp: string };
}

export interface Invitation {
  readonly seat: MatchSeat;
  readonly connectionId: string;
  readonly description: { type: 'offer'; sdp: string };
}

export class WebRtcLink implements MatchLink {
  #peer = new RTCPeerConnection({ iceServers: [] });
  #channel: RTCDataChannel | undefined;
  #status: LinkStatus = 'connecting';
  #statusListeners = new Set<(status: LinkStatus) => void>();
  #messageListeners = new Set<(message: string) => void>();
  #deadline: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.#peer.onconnectionstatechange = () => {
      const state = this.#peer.connectionState;
      if (state === 'failed' || state === 'closed') this.close();
      if (state === 'disconnected' && this.#status === 'open') this.close();
    };
    this.#peer.oniceconnectionstatechange = () => {
      const state = this.#peer.iceConnectionState;
      if (state === 'failed' || state === 'closed') this.close();
      if (state === 'disconnected' && this.#status === 'open') this.close();
    };
    this.#peer.ondatachannel = ({ channel }) => this.#bind(channel);
  }

  get status(): LinkStatus {
    return this.#status;
  }

  onStatus(listener: (status: LinkStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onMessage(listener: (message: string) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  send(message: string): void {
    const channel = this.#channel;
    if (this.#status !== 'open' || channel?.readyState !== 'open') {
      throw new Error('连接已中断。');
    }
    const bytes = messageBytes(message);
    if (bytes > MAX_FRAME_BYTES || channel.bufferedAmount + bytes > 64 * 1024) {
      throw new Error('联机消息过大或发送队列已满。');
    }
    channel.send(message);
  }

  close(): void {
    if (this.#status === 'closed') return;
    this.#status = 'closed';
    clearTimeout(this.#deadline);
    this.#peer.close();
    this.#channel?.close();
    for (const listener of this.#statusListeners) listener('closed');
    this.#statusListeners.clear();
    this.#messageListeners.clear();
  }

  async offer(seat: MatchSeat): Promise<{ code: string; accept: (code: string) => Promise<void> }> {
    this.#bind(this.#peer.createDataChannel(LABEL, { ordered: true }));
    const connectionId = randomId();
    const description = await this.#gather(await this.#peer.createOffer(), 'offer');
    const code = encode({ version: PROTOCOL_VERSION, connectionId, seat, description });
    return {
      code,
      accept: async (answer) => {
        const response = decode(answer);
        if (response.description.type !== 'answer' || response.connectionId !== connectionId
          || !sameMatch(response.seat, seat) || response.seat.player === seat.player) {
          throw new Error('回应与这次邀请不匹配，请检查配对码。');
        }
        await this.#peer.setRemoteDescription(response.description);
        this.#startDeadline();
      },
    };
  }

  async answer(invitation: Invitation): Promise<string> {
    await this.#peer.setRemoteDescription(invitation.description);
    const description = await this.#gather(await this.#peer.createAnswer(), 'answer');
    const { seat, connectionId } = invitation;
    this.#startDeadline();
    return encode({
      version: PROTOCOL_VERSION,
      connectionId,
      seat: { ...seat, player: seat.player === 0 ? 1 : 0 },
      description,
    });
  }

  #startDeadline(): void {
    if (this.#status !== 'connecting') return;
    clearTimeout(this.#deadline);
    this.#deadline = setTimeout(() => this.close(), CONNECTION_TIMEOUT);
  }

  #bind(channel: RTCDataChannel): void {
    if (this.#channel || channel.label !== LABEL || !channel.ordered
      || channel.maxPacketLifeTime !== null || channel.maxRetransmits !== null) {
      channel.close();
      this.close();
      return;
    }
    this.#channel = channel;
    channel.onmessage = ({ data }) => {
      if (typeof data !== 'string' || messageBytes(data) > MAX_FRAME_BYTES) {
        this.close();
        return;
      }
      for (const listener of this.#messageListeners) listener(data);
    };
    channel.onclose = () => this.close();
    channel.onerror = () => this.close();
    const markOpen = () => {
      if (this.#status !== 'connecting') return;
      clearTimeout(this.#deadline);
      this.#status = 'open';
      for (const listener of this.#statusListeners) listener('open');
    };
    channel.onopen = markOpen;
    if (channel.readyState === 'open') markOpen();
  }

  async #gather<T extends 'offer' | 'answer'>(
    description: RTCSessionDescriptionInit, type: T,
  ): Promise<{ type: T; sdp: string }> {
    await this.#peer.setLocalDescription(description);
    if (this.#peer.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve, reject) => {
        const complete = () => {
          if (this.#peer.iceGatheringState === 'complete') finish();
        };
        const cancel = this.onStatus((status) => {
          if (status === 'closed') finish(new Error('配对已取消。'));
        });
        const timeout = setTimeout(() => finish(new Error('获取局域网地址超时。')), ICE_TIMEOUT);
        const finish = (error?: Error) => {
          clearTimeout(timeout);
          cancel();
          this.#peer.removeEventListener('icegatheringstatechange', complete);
          if (error) reject(error);
          else resolve();
        };
        this.#peer.addEventListener('icegatheringstatechange', complete);
        if (this.#status === 'closed') finish(new Error('配对已取消。'));
        else complete();
      });
    }
    const sdp = this.#peer.localDescription?.sdp;
    if (!sdp || !/^a=candidate:/m.test(sdp)) {
      throw new Error('浏览器未找到可用的局域网地址，请检查网络及浏览器权限。');
    }
    return { type, sdp };
  }
}

export function parseInvitation(code: string): Invitation {
  const invitation = decode(code);
  if (invitation.description.type !== 'offer') throw new Error('请粘贴对方的邀请。');
  return { ...invitation, description: { type: 'offer', sdp: invitation.description.sdp } };
}

export function sameMatch(left: MatchSeat, right: MatchSeat): boolean {
  return left.matchId === right.matchId && left.secret === right.secret
    && left.gameId === right.gameId && left.rulesVersion === right.rulesVersion;
}

function encode(pairing: Pairing): string {
  const bytes = new TextEncoder().encode(JSON.stringify(pairing));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  const code = PAIR_PREFIX + btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  if (code.length > MAX_CODE_LENGTH) throw new Error('配对码太长。');
  return code;
}

function decode(input: string): Pairing {
  const code = input.trim();
  if (code.length > MAX_CODE_LENGTH || !code.startsWith(PAIR_PREFIX)
    || !/^[\w-]+$/.test(code.slice(PAIR_PREFIX.length))) {
    throw new Error('配对码格式无效。');
  }
  let value: unknown;
  try {
    const binary = atob(code.slice(PAIR_PREFIX.length).replaceAll('-', '+').replaceAll('_', '/'));
    value = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
  } catch {
    throw new Error('配对码格式无效。');
  }
  if (!isObject(value) || value.version !== PROTOCOL_VERSION || !isId(value.connectionId)) {
    throw new Error('配对码或协议版本无效。');
  }
  const { seat, description } = value;
  if (!isObject(seat) || !isId(seat.matchId) || !isId(seat.secret) || !isPlayer(seat.player)
    || !isGameId(seat.gameId) || !isRevision(seat.rulesVersion) || !isObject(description)
    || (description.type !== 'offer' && description.type !== 'answer')
    || typeof description.sdp !== 'string' || !description.sdp.startsWith('v=0')) {
    throw new Error('配对码格式无效。');
  }
  const { matchId, secret, player, gameId, rulesVersion } = seat;
  const { type, sdp } = description;
  return {
    version: PROTOCOL_VERSION,
    connectionId: value.connectionId,
    seat: { matchId, secret, player, gameId, rulesVersion },
    description: { type, sdp },
  };
}
