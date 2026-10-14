import { loadConfig, speakersForNamespace, type DreamSpeakers } from "../gateway/config";
import { isOctoberContractEnabled, OCTOBER_NAMESPACE } from "../october/contract";
import type { Env, MessageRecord } from "../types";
import { cleanMessageText } from "../utils/sanitize";

export type { DreamSpeakers };

/** Xu Heng's own memory rules (SPEC B5), from the private deployment config; empty everywhere else. */
export function octoberDreamRules(env: Env): string {
  if (!isOctoberContractEnabled(env)) return "";
  return env.OCTOBER_XH_DREAM_RULES?.trim() ?? "";
}

/** The rules as a prompt section that wins over the generic rules above it. */
export function personRulesSection(rules: string): string[] {
  if (!rules) return [];
  return ["", "这个人自己的记忆规则（和上面的通用规则冲突时，以这里为准）：", rules, ""];
}

/** Xu Heng's speakers come from deployment config; Gu Chen is named apart so his words never pass as hers. */
export function octoberSpeakers(env: Env): DreamSpeakers | null {
  const userName = env.OCTOBER_XH_USER_NAME?.trim();
  const assistantName = env.OCTOBER_XH_ASSISTANT_NAME?.trim();
  const guChen = env.OCTOBER_XH_GU_CHEN_NAME?.trim() || "另一位参与者";
  if (!userName || !assistantName) return null;
  return { userName, assistantName, others: { "participant:gu-chen": guChen } };
}

export async function loadSpeakersForNamespace(env: Env, namespace: string): Promise<DreamSpeakers | null> {
  if (namespace === OCTOBER_NAMESPACE && isOctoberContractEnabled(env)) return octoberSpeakers(env);
  try {
    return speakersForNamespace(await loadConfig(env), namespace);
  } catch {
    return null;
  }
}

export function speakerLabel(role: string, speakers: DreamSpeakers | null, speaker?: string | null): string {
  if (speaker && speaker === "participant:gu-chen") return speakers?.others?.[speaker] ?? "另一位参与者";
  if (role === "assistant") return speakers?.assistantName ?? "我(助手)";
  return speakers?.userName ?? "用户";
}

export function formatSpeakerTranscript(
  messages: MessageRecord[],
  speakers: DreamSpeakers | null,
  maxChars: number,
  ellipsis = false
): string {
  return messages
    .map((message) => {
      const text = cleanMessageText(message.content);
      const clipped = text.length <= maxChars ? text : ellipsis ? `${text.slice(0, maxChars)}…` : text.slice(0, maxChars);
      return `[${message.id}][${message.created_at}][${speakerLabel(message.role, speakers, message.speaker)}] ${clipped}`;
    })
    .join("\n\n");
}

export function nameOnlyRule(speakers: DreamSpeakers): string {
  const base = `只许用「${speakers.userName}」和「${speakers.assistantName}」指称双方。禁止出现 user、用户、assistant、助手，也不要用「你」「我」代替这两人。`;
  const others = Object.values(speakers.others ?? {});
  if (others.length === 0) return base;
  const names = others.map((name) => `「${name}」`).join("、");
  return `${base}transcript 里标为${names}的话是他说的，不是${speakers.userName}或${speakers.assistantName}说的，写进记忆时也要写成他说的。`;
}

export function diarySpeakerRules(speakers: DreamSpeakers | null): string[] {
  if (!speakers) {
    return ["- 用「我」指代助手自己；提到用户时用「她」或具体称呼，不要用「用户」。"];
  }
  return [
    `- 说话人：用户是${speakers.userName}，助手是${speakers.assistantName}。下面 transcript 已用这两个名字标注角色。`,
    `- 这是${speakers.assistantName}写给自己的日记。提到对方必须写「${speakers.userName}」，提到自己写「${speakers.assistantName}」。${nameOnlyRule(speakers)}`
  ];
}

export function rollupSpeakerRule(speakers: DreamSpeakers | null): string {
  if (!speakers) {
    return "- 站在「我=助手」视角；关于用户用「你」，关于助手承诺用「我需要」。";
  }
  return `- 说话人：用户是${speakers.userName}，助手是${speakers.assistantName}。${nameOnlyRule(speakers)}`;
}

export function judgeSpeakerRules(speakers: DreamSpeakers | null): string[] {
  if (!speakers) return [];
  return [
    `- 说话人：用户是${speakers.userName}，助手是${speakers.assistantName}。transcript 已用这两个名字标注。`,
    "- reason 里也只用这两个名字，不要写用户/助手。"
  ];
}
