import type { MatchRules, Player } from '../multiplayer';

export type DemoState = { total: number; turn: Player; winner: Player | null };
export type DemoAction = { add: 1 | 2 | 3 };
export const TARGET = 15;

export const demoRules: MatchRules<DemoState, DemoAction> = {
  gameId: 'count-to-15',
  version: 1,
  initialState: () => ({ total: 0, turn: 0, winner: null }),
  nextPlayer: (state) => state.winner === null ? state.turn : null,
  isAction: (action): action is DemoAction => {
    if (action === null || typeof action !== 'object' || Array.isArray(action)) return false;
    return Object.keys(action).length === 1
      && (action.add === 1 || action.add === 2 || action.add === 3);
  },
  apply: (state, player, { add }) => {
    const total = state.total + add;
    if (total > TARGET) return null;
    return {
      total, turn: player === 0 ? 1 : 0, winner: total === TARGET ? player : null,
    };
  },
};
