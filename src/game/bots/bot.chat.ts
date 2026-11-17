/**
 * 말하는 봇(라이어·마피아) 공통: 같은 방에서 같은 말을 되풀이하지 않게.
 * 방마다 최근에 나온 봇 말을 기억해, LLM 답이 겹치면 버리고 미리 써 둔 문장도 안 쓴 것부터 고른다.
 * (예전엔 문장이 5개뿐이고 봇마다 따로 뽑아서 "누가 수상하지?"가 한 판에 여러 번 나왔다)
 */
const RECENT_MAX = 40;
const ROOMS_MAX = 200;
const recentByRoom = new Map<string, string[]>();

const norm = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

export function rememberLine(roomName: string, text: string): void {
  const n = norm(text);
  if (!n) return;
  // 같은 말을 봇마다 받아서 여러 번 기억하면 목록이 금방 차 버린다 — 하나만 남긴다
  const list = (recentByRoom.get(roomName) ?? []).filter((x) => x !== n);
  list.push(n);
  if (list.length > RECENT_MAX) list.splice(0, list.length - RECENT_MAX);
  recentByRoom.delete(roomName); // 최근에 쓴 방을 맨 뒤로
  recentByRoom.set(roomName, list);
  // 없어진 방 기록이 쌓이지 않게, 오래 안 쓴 방부터 지운다
  if (recentByRoom.size > ROOMS_MAX) {
    const oldest = [...recentByRoom.keys()][0];
    recentByRoom.delete(oldest);
  }
}

export function isRepeat(roomName: string, text: string): boolean {
  const n = norm(text);
  return !!n && (recentByRoom.get(roomName) ?? []).includes(n);
}

/**
 * 이 방에서 아직 안 나온 문장 중 하나 (다 나왔으면 가장 오래전에 나온 것).
 * 고른 문장(틀) 자체도 기억한다 — "{name} 너무 조용한데"처럼 이름이 바뀌는 문장은 채운 결과만 기억하면 틀이 계속 다시 뽑혔다
 */
export function freshPick(roomName: string, pool: string[]): string {
  const recent = recentByRoom.get(roomName) ?? [];
  const unused = pool.filter((p) => !recent.includes(norm(p)));
  const chosen =
    unused.length > 0
      ? unused[Math.floor(Math.random() * unused.length)]
      : [...pool].sort(
          (a, b) => recent.indexOf(norm(a)) - recent.indexOf(norm(b)),
        )[0];
  rememberLine(roomName, chosen);
  return chosen;
}

/** LLM에게 줄 지시: 이미 나온 말과 겹치지 않게 */
export const NO_REPEAT_RULE =
  '최근 채팅에 이미 나온 말(너의 말 포함, "(나)" 표시)과 같은 말이나 비슷한 말은 절대 하지 말고, 대화를 이어 가는 새로운 말을 해라. 누군가에게 대답하거나, 특정 사람을 짚어 묻거나, 투표 얘기를 하는 식으로.';
