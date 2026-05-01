export const SOURCE_NATIVE_EVENT_TYPES = [
  'article',
  'ask_hn',
  'comment',
  'commit',
  'discussion',
  'email',
  'file',
  'issue',
  'issue_comment',
  'message',
  'photo',
  'post',
  'pr_comment',
  'pull_request',
  'reply',
  'repository',
  'review',
  'section',
  'show_hn',
  'story',
  'thread',
  'tweet',
  'video',
] as const;

const SOURCE_NATIVE_EVENT_TYPE_SET = new Set<string>(SOURCE_NATIVE_EVENT_TYPES);

export function isSourceNativeEventType(value: string | null | undefined): boolean {
  return typeof value === 'string' && SOURCE_NATIVE_EVENT_TYPE_SET.has(value);
}
