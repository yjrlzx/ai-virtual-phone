import type { Character } from "./character-types";

/** 从 assistant 回复文本里解析 <mood affinity=X possessiveness=Y anxiety=Z /> 标签 */
export function parseMoodFromText(text: string): { affinity: number; possessiveness: number; anxiety: number } | null {
  const m = text.match(/<mood\s+affinity=(\d+)\s+possessiveness=(\d+)\s+anxiety=(\d+)\s*\/>/);
  if (!m) return null;
  return {
    affinity: Math.min(100, Math.max(0, parseInt(m[1], 10) || 50)),
    possessiveness: Math.min(100, Math.max(0, parseInt(m[2], 10) || 20)),
    anxiety: Math.min(100, Math.max(0, parseInt(m[3], 10) || 10)),
  };
}

/** 把 mood 写回 character（不 await，fire-and-forget） */
export async function saveMoodToCharacter(characterId: string, mood: { affinity: number; possessiveness: number; anxiety: number }) {
  try {
    const { loadCharacters, saveCharacters } = await import("./character-storage");
    const chars = loadCharacters();
    const c = chars.find(x => x.id === characterId);
    if (!c) return;
    c.mood = { ...mood, updatedAt: new Date().toISOString() };
    saveCharacters(chars);
  } catch { /* ignore */ }
}

/** 从 character 读 mood */
export function readMood(c: Character | undefined | null): { affinity: number; possessiveness: number; anxiety: number } {
  return c?.mood ?? { affinity: 50, possessiveness: 20, anxiety: 10 };
}
