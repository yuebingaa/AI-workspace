const lightweightConversationPattern = /^(?:嗯+|唔+|额+|呃+|哦+|噢+|啊+|好的?|好吧|行|知道了|明白了|收到|谢谢(?:你)?|多谢|你好|您好|嗨|在吗|hi|hello)[。！!？?…~～\s]*$/iu;

export function isLightweightConversation(instruction: string): boolean {
  return lightweightConversationPattern.test(instruction.trim());
}

export function lightweightConversationReply(instruction: string, hasEdsContext: boolean): string {
  const normalized = instruction.trim();
  const guidance = hasEdsContext
    ? "当前 EDS 汇总已经就绪。你可以继续问“为什么夜班异常更多”“详细展开 A5FSL05”或“给出前三项改善建议”。"
    : "你可以直接告诉我想检查的数据、指标或页面。";

  if (/^(?:谢谢(?:你)?|多谢)/u.test(normalized)) return `不客气。${guidance}`;
  if (/^(?:你好|您好|嗨|在吗|hi|hello)/iu.test(normalized)) return `你好，我在。${guidance}`;
  return `我在。${guidance}`;
}
